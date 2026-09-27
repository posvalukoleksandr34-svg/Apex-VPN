import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pickLocale } from "@/i18n/locale";
import { fmt } from "@/i18n/format";
import { safeNext } from "./paths";
import { searchServers, serverRows, configurable } from "./servers";
import { ApiFailure } from "./api";
import { SessionRefresher } from "./refresh";
import { fromTokens, needsRefresh, seal, SESSION_MAX_AGE_S, sessionCookie, unseal } from "./session";
import type { RelayList } from "./types";
import { webSessionName } from "./ua";
import { buildConfig, configFileName, fromBase64, generateKeyPair, publicKeyOf, toBase64 } from "./wireguard";

const secret = () => new Uint8Array(randomBytes(32));
const tokens = {
  accessToken: "access.jwt",
  refreshToken: "r".repeat(43),
  expiresIn: 900,
  sessionId: "5b0e9d1c-7c55-4c8b-9f65-0d3a2d8b1f00",
  user: { id: "u1", email: "a@example.com", emailVerified: true, locale: "en", mfaEnabled: false, role: "user" as const, createdAt: "2026-01-01T00:00:00Z" },
};

describe("session cookie", () => {
  it("round-trips and hides the tokens", async () => {
    const key = secret();
    const s = fromTokens(tokens, 1_000_000);
    const sealed = await seal(s, key);
    expect(sealed).not.toContain("access.jwt");
    expect(sealed).not.toContain("a@example.com");
    expect(await unseal(sealed, key)).toEqual(s);
  });

  it("refuses a cookie sealed with another key, tampered with, or expired", async () => {
    const key = secret();
    const sealed = await seal(fromTokens(tokens), key);
    expect(await unseal(sealed, secret())).toBeNull();
    const parts = sealed.split(".");
    parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.endsWith("AA") ? "BB" : "AA");
    expect(await unseal(parts.join("."), key)).toBeNull();
    expect(await unseal("not a cookie", key)).toBeNull();
    const now = Date.now();
    const old = await seal(fromTokens(tokens, now), key, now);
    expect(await unseal(old, key, now + (SESSION_MAX_AGE_S + 60) * 1000)).toBeNull();
  });

  it("refreshes shortly before the access token expires", () => {
    const s = fromTokens(tokens, 0);
    expect(needsRefresh(s, 0)).toBe(false);
    expect(needsRefresh(s, 800_000)).toBe(true);
  });

  it("uses a __Host- cookie over HTTPS", () => {
    expect(sessionCookie(true)).toMatchObject({ name: "__Host-apexy", options: { secure: true, httpOnly: true, sameSite: "lax", path: "/" } });
    expect(sessionCookie(false).name).toBe("apexy");
  });
});

describe("safeNext", () => {
  it("keeps paths on this site", () => {
    expect(safeNext("/devices?add=1")).toBe("/devices?add=1");
    expect(safeNext("/billing")).toBe("/billing");
  });

  it("drops anything that could leave it", () => {
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "\\\\evil", "javascript:alert(1)", "/\u0000x", "", null, "/login?next=/x", "/auth/expired"]) {
      expect(safeNext(bad)).toBeNull();
    }
  });
});

describe("WireGuard keys", () => {
  it("derives public keys per RFC 7748", () => {
    const alice = "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a";
    const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)));
    expect(publicKeyOf(toBase64(hex(alice)))).toBe(toBase64(hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")));
  });

  it("makes clamped keys, as wg genkey does", () => {
    const pair = generateKeyPair(() => new Uint8Array(32).fill(255));
    const sk = fromBase64(pair.privateKey);
    expect(sk[0]! & 7).toBe(0);
    expect(sk[31]! & 128).toBe(0);
    expect(sk[31]! & 64).toBe(64);
    expect(pair.publicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(publicKeyOf(pair.privateKey)).toBe(pair.publicKey);
    expect(generateKeyPair().privateKey).not.toBe(generateKeyPair().privateKey);
  });
});

describe("WireGuard config", () => {
  const server = { id: "de-fra-001", hostname: "de-fra-001.example.net", publicKey: "S".repeat(43) + "=", endpoint: "203.0.113.10", port: 51820, dns: "10.64.0.1", ipv6: true };

  it("sends everything through the tunnel", () => {
    const conf = buildConfig({ privateKey: "P".repeat(43) + "=", ipv4Address: "10.64.0.2", ipv6Address: "fc00:bbbb:bbbb:bb01::2", server });
    expect(conf).toContain("PrivateKey = " + "P".repeat(43) + "=");
    expect(conf).toContain("Address = 10.64.0.2/32, fc00:bbbb:bbbb:bb01::2/128");
    expect(conf).toContain("DNS = 10.64.0.1");
    expect(conf).toContain("AllowedIPs = 0.0.0.0/0, ::/0");
    expect(conf).toContain("Endpoint = 203.0.113.10:51820");
  });

  it("leaves out IPv6 addresses the server can't route, but still captures IPv6", () => {
    const conf = buildConfig({ privateKey: "P".repeat(43) + "=", ipv4Address: "10.64.0.2", ipv6Address: "fc00::2", server: { ...server, ipv6: false } });
    expect(conf).toContain("Address = 10.64.0.2/32\n");
    expect(conf).toContain("AllowedIPs = 0.0.0.0/0, ::/0");
  });

  it("names files as WireGuard apps accept", () => {
    expect(configFileName("de-fra-001")).toBe("apx-de-fra-001.conf");
    expect(configFileName("a-very-long-server-name")).toBe("apx-a-very-long.conf");
    expect(configFileName("x/../y z")).toBe("apx-x..yz.conf");
  });
});

describe("servers", () => {
  const list: RelayList = {
    version: 1,
    generatedAt: 0,
    expiresAt: 0,
    locations: [
      { id: "de-fra", countryCode: "DE", country: "Germany", city: "Frankfurt" },
      { id: "ch-zrh", countryCode: "CH", country: "Switzerland", city: "Zürich" },
    ],
    servers: [
      { id: "de-fra-002", hostname: "de-fra-002.x", locationId: "de-fra", status: "busy", load: 90, capacity: 1, features: ["p2p"], ipv4: "203.0.113.2", ipv6: null, wireguard: { publicKey: "k", ports: [51820], gatewayIpv4: "10.64.0.1", gatewayIpv6: null, dnsIpv4: null } },
      { id: "de-fra-001", hostname: "de-fra-001.x", locationId: "de-fra", status: "online", load: 40, capacity: 1, features: ["streaming"], ipv4: "203.0.113.1", ipv6: null, wireguard: { publicKey: "k", ports: [51820], gatewayIpv4: "10.64.0.1", gatewayIpv6: null, dnsIpv4: null } },
      { id: "ch-zrh-001", hostname: "ch-zrh-001.x", locationId: "ch-zrh", status: "online", load: 10, capacity: 1, features: [], ipv4: "203.0.113.3", ipv6: null, wireguard: null },
    ],
  };
  const rows = serverRows(list);

  it("searches every word across place, name and features (accents too)", () => {
    expect(searchServers(rows, "germany p2p").map((r) => r.id)).toEqual(["de-fra-002"]);
    expect(searchServers(rows, "zurich").map((r) => r.id)).toEqual(["ch-zrh-001"]);
    expect(searchServers(rows, "Streaming", { streaming: "Стриминг" }).map((r) => r.id)).toEqual(["de-fra-001"]);
    expect(searchServers(rows, "стрим", { streaming: "Стриминг" }).map((r) => r.id)).toEqual(["de-fra-001"]);
    expect(searchServers(rows, "  ")).toHaveLength(3);
  });

  it("offers servers with a WireGuard key, online and least loaded first", () => {
    expect(configurable(rows).map((r) => r.id)).toEqual(["de-fra-001", "de-fra-002"]);
    expect(rows.find((r) => r.id === "de-fra-001")!.wireguard).toMatchObject({ endpoint: "203.0.113.1", port: 51820, dns: "10.64.0.1" });
  });
});

describe("language and text", () => {
  it("prefers the chosen language, then the browser's", () => {
    expect(pickLocale("de", "ru,en;q=0.8")).toBe("de");
    expect(pickLocale(undefined, "fr-FR,it;q=0.9,en;q=0.5")).toBe("it");
    expect(pickLocale("xx", "ru-RU")).toBe("ru");
    expect(pickLocale(undefined, null)).toBe("en");
  });

  it("fills placeholders and leaves unknown ones visible", () => {
    expect(fmt("{used} of {limit}", { used: 3, limit: 5 })).toBe("3 of 5");
    expect(fmt("{missing}")).toBe("{missing}");
  });

  it("names web sessions without keeping the user agent", () => {
    expect(webSessionName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36")).toBe("Chrome on Windows");
    expect(webSessionName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
    expect(webSessionName(null)).toBe("Browser");
  });
});

describe("session refresh", () => {
  const session = (rt: string, atExp: number) => ({ at: `at-${rt}`, atExp, rt, sid: "s", uid: "u", email: "a@example.com" });
  const reply = (rt: string) => ({ ...tokens, accessToken: `at-${rt}`, refreshToken: rt });

  it("rotates once for concurrent requests, and gives a rotated token its successor", async () => {
    let now = 1_000_000;
    const calls: string[] = [];
    const r = new SessionRefresher(async (rt) => {
      calls.push(rt);
      await new Promise((res) => setTimeout(res, 5));
      return reply(`${rt}+`);
    }, () => now);
    const stale = session("R1", now + 30_000);
    const [a, b] = await Promise.all([r.refresh(stale), r.refresh(stale)]);
    expect(calls).toEqual(["R1"]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ kind: "fresh", session: { rt: "R1+" } });
    // Minutes later the browser sends R1 again (the new cookie never arrived): no API call.
    now += 5 * 60_000;
    expect(await r.refresh(stale)).toMatchObject({ kind: "fresh", session: { rt: "R1+" } });
    expect(calls).toEqual(["R1"]);
  });

  it("follows rotations and refreshes the newest when it's due too", async () => {
    let now = 0;
    const calls: string[] = [];
    const r = new SessionRefresher(async (rt) => (calls.push(rt), reply(`${rt}+`)), () => now, 60 * 60_000);
    await r.refresh(session("R1", 10_000));
    now += 900_000; // R1+ (expiresIn 900 s) is now due as well
    expect(await r.refresh(session("R1", 10_000))).toMatchObject({ kind: "fresh", session: { rt: "R1++" } });
    expect(calls).toEqual(["R1", "R1+"]);
  });

  it("ends on 401, keeps the token on 409 or an outage, and forgets after a while", async () => {
    let now = 0;
    let fail: ApiFailure | null = new ApiFailure(409, "refresh_in_progress", "");
    const r = new SessionRefresher(async (rt) => {
      if (fail) throw fail;
      return reply(`${rt}+`);
    }, () => now, 60_000);
    expect(await r.refresh(session("R1", 10_000))).toEqual({ kind: "keep" });
    fail = new ApiFailure(0, "api_unreachable", "");
    expect(await r.refresh(session("R1", 10_000))).toEqual({ kind: "keep" });
    fail = new ApiFailure(401, "session_revoked", "");
    expect(await r.refresh(session("R1", 10_000))).toEqual({ kind: "ended" });
    fail = null;
    await r.refresh(session("R2", 10_000));
    now += 61_000;
    fail = new ApiFailure(401, "session_revoked", "");
    expect(await r.refresh(session("R2", 10_000))).toEqual({ kind: "ended" }); // remembered no longer
  });

  it("doesn't refresh a session that isn't due", async () => {
    const r = new SessionRefresher(async () => {
      throw new Error("should not be called");
    }, () => 0);
    expect(await r.refresh(session("R1", 600_000))).toEqual({ kind: "keep" });
  });
});
