import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyDetached } from "../src/security/keys.js";
import { sha256 } from "../src/security/tokens.js";
import { json, signedInUser, testApp, wgKey, type TestApp } from "./helpers.js";

let t: TestApp;
beforeEach(async () => (t = await testApp()));
afterEach(async () => t.close());

const NODE_TOKEN = "node-token-for-tests-0123456789abcdef";

async function seedFleet() {
  const { db } = t.deps.database;
  await db.insertInto("fleet.locations").values([
    { id: "de-fra", country_code: "DE", country: "Germany", city: "Frankfurt", latitude: 50.11, longitude: 8.68 },
    { id: "nl-ams", country_code: "NL", country: "Netherlands", city: "Amsterdam", latitude: 52.37, longitude: 4.9 },
  ]).execute();
  await db.insertInto("fleet.servers").values([
    {
      id: "de-fra-001",
      hostname: "de-fra-001.relays.example.net",
      location_id: "de-fra",
      ipv4: "185.65.134.10",
      status: "online",
      capacity: 100,
      features: ["streaming", "p2p"],
      wg_public_key: wgKey(),
      wg_ports: [51820, 443],
      wg_gateway_ipv4: "10.64.0.1",
      node_token_hash: sha256(NODE_TOKEN),
    },
    {
      id: "nl-ams-001",
      hostname: "nl-ams-001.relays.example.net",
      location_id: "nl-ams",
      ipv4: "185.65.135.10",
      status: "maintenance",
      capacity: 100,
      wg_public_key: wgKey(),
      wg_gateway_ipv4: "10.64.0.1",
    },
  ]).execute();
}

function decode(signed: { payload: string; signature: string; keyId: string }) {
  const bytes = Buffer.from(signed.payload, "base64");
  expect(verifyDetached(t.deps.keys.relay, bytes, Buffer.from(signed.signature, "base64"))).toBe(true);
  return JSON.parse(bytes.toString("utf8"));
}

describe("relay list", () => {
  it("is signed, versioned, and publishes only measured health", async () => {
    await seedFleet();
    const first = decode(json(await t.app.inject({ method: "GET", url: "/v1/servers/relays" })));
    const fra = first.servers.find((s: { id: string }) => s.id === "de-fra-001");
    // No heartbeat yet: not "online", and no invented load.
    expect(fra.status).toBe("offline");
    expect(fra.load).toBeNull();
    expect(fra.health).toBeNull();
    expect(first.servers.find((s: { id: string }) => s.id === "nl-ams-001").status).toBe("maintenance");

    const hb = await t.app.inject({
      method: "POST",
      url: "/v1/nodes/self/heartbeat",
      headers: { authorization: `Bearer ${NODE_TOKEN}` },
      payload: { wgHealthy: true, activeKeys: Array.from({ length: 30 }, wgKey) },
    });
    expect(hb.statusCode).toBe(204);

    t.clock.advance(61_000); // past the rebuild interval
    const second = decode(json(await t.app.inject({ method: "GET", url: "/v1/servers/relays" })));
    const fra2 = second.servers.find((s: { id: string }) => s.id === "de-fra-001");
    expect(fra2.status).toBe("online");
    expect(fra2.load).toBe(30);
    expect(fra2.health.wireguardHealthy).toBe(true);
    expect(second.version).toBeGreaterThan(first.version);
    expect(second.expiresAt).toBeGreaterThan(second.generatedAt);

    // Shape the Rust service deserializes (vpn_types::RelayList).
    expect(Object.keys(fra2).sort()).toEqual(
      ["capacity", "features", "health", "hostname", "id", "ikev2", "ipv4", "ipv6", "load", "locationId", "openvpn", "status", "wireguard"].sort(),
    );
    expect(Object.keys(fra2.wireguard).sort()).toEqual(["dnsIpv4", "gatewayIpv4", "gatewayIpv6", "ports", "publicKey"]);
    expect(fra2.wireguard.dnsIpv4).toBeNull();
    expect(fra2.ipv4).toBe("185.65.134.10");

    // Contract fixture for the Rust verifier (crates/vpn-core/tests).
    if (process.env.UPDATE_FIXTURES) {
      writeFileSync(
        join(import.meta.dirname, "../../../crates/vpn-core/tests/fixtures/relay_list_from_api.json"),
        JSON.stringify({ publicKey: t.deps.keys.relay.publicKeyBase64, signed: json(await t.app.inject({ method: "GET", url: "/v1/servers/relays" })) }, null, 2),
      );
    }
  });

  it("marks a node over 85% capacity busy", async () => {
    await seedFleet();
    await t.app.inject({
      method: "POST",
      url: "/v1/nodes/self/heartbeat",
      headers: { authorization: `Bearer ${NODE_TOKEN}` },
      payload: { wgHealthy: true, activeKeys: Array.from({ length: 90 }, wgKey) },
    });
    const list = decode(json(await t.app.inject({ method: "GET", url: "/v1/servers/relays" })));
    expect(list.servers.find((s: { id: string }) => s.id === "de-fra-001").status).toBe("busy");
  });

  it("rejects unknown node tokens", async () => {
    await seedFleet();
    const res = await t.app.inject({ method: "GET", url: "/v1/nodes/self/peers", headers: { authorization: "Bearer nope" } });
    expect(res.statusCode).toBe(401);
  });
});

describe("devices", () => {
  it("registers keys within the plan's limit and serves them to nodes", async () => {
    await seedFleet();
    const u = await signedInUser(t);
    const key = wgKey();
    const reg = await t.app.inject({
      method: "POST",
      url: "/v1/devices",
      headers: u.auth,
      payload: { name: "Laptop", platform: "windows", publicKey: key },
    });
    expect(reg.statusCode).toBe(201);
    const { registration } = json(reg);
    expect(registration.publicKey).toBe(key);
    expect(registration.ipv4Address).toMatch(/^10\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./);
    expect(registration.ipv6Address).toMatch(/^fc00:bbbb:bbbb:bb01:/);
    expect(registration.validUntil).toBeGreaterThan(t.clock.now.getTime());

    // Idempotent per key.
    const again = json(await t.app.inject({ method: "POST", url: "/v1/devices", headers: u.auth, payload: { name: "Laptop", platform: "windows", publicKey: key } }));
    expect(again.registration.deviceId).toBe(registration.deviceId);

    // Also when two enrollments of a new key race (the app and a retry).
    await t.app.inject({ method: "DELETE", url: `/v1/devices/${registration.deviceId}`, headers: u.auth });
    const raced = wgKey();
    const both = await Promise.all(
      [1, 2].map(() => t.app.inject({ method: "POST", url: "/v1/devices", headers: u.auth, payload: { name: "Laptop", platform: "windows", publicKey: raced } })),
    );
    expect(both.map((r) => r.statusCode)).toEqual([201, 201]);
    expect(new Set(both.map((r) => json(r).registration.deviceId)).size).toBe(1);
    await t.app.inject({ method: "DELETE", url: `/v1/devices/${json(both[0]!).registration.deviceId}`, headers: u.auth });
    const { registration: kept } = json(await t.app.inject({ method: "POST", url: "/v1/devices", headers: u.auth, payload: { name: "Laptop", platform: "windows", publicKey: key } }));
    Object.assign(registration, kept);

    await t.app.inject({ method: "POST", url: "/v1/devices", headers: u.auth, payload: { name: "Desktop", platform: "linux", publicKey: wgKey() } });
    const third = await t.app.inject({ method: "POST", url: "/v1/devices", headers: u.auth, payload: { name: "Phone", platform: "other", publicKey: wgKey() } });
    expect(json(third).error.code).toBe("device_limit_reached");

    const peers = json(await t.app.inject({ method: "GET", url: "/v1/nodes/self/peers", headers: { authorization: `Bearer ${NODE_TOKEN}` } }));
    expect(peers.peers.map((p: { publicKey: string }) => p.publicKey)).toContain(key);
    expect(peers.peers.find((p: { publicKey: string }) => p.publicKey === key).allowedIps[0]).toBe(`${registration.ipv4Address}/32`);

    // Revoked devices disappear from the node's peer set.
    await t.app.inject({ method: "DELETE", url: `/v1/devices/${registration.deviceId}`, headers: u.auth });
    const after = json(await t.app.inject({ method: "GET", url: "/v1/nodes/self/peers", headers: { authorization: `Bearer ${NODE_TOKEN}` } }));
    expect(after.peers.map((p: { publicKey: string }) => p.publicKey)).not.toContain(key);
  });

  it("requires a verified email and valid keys; a key can't be claimed twice", async () => {
    const res = await t.app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "unverified@example.com", password: "correct horse battery staple" } });
    expect(res.statusCode).toBe(202);
    const login = json(await t.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "unverified@example.com", password: "correct horse battery staple" } }));
    const unverified = await t.app.inject({ method: "POST", url: "/v1/devices", headers: { authorization: `Bearer ${login.accessToken}` }, payload: { name: "PC", platform: "windows", publicKey: wgKey() } });
    expect(json(unverified).error.code).toBe("email_unverified");

    const a = await signedInUser(t);
    const b = await signedInUser(t);
    const bad = await t.app.inject({ method: "POST", url: "/v1/devices", headers: a.auth, payload: { name: "PC", platform: "windows", publicKey: "not-a-key" } });
    expect(json(bad).error.code).toBe("invalid_request");
    const key = wgKey();
    await t.app.inject({ method: "POST", url: "/v1/devices", headers: a.auth, payload: { name: "PC", platform: "windows", publicKey: key } });
    const stolen = await t.app.inject({ method: "POST", url: "/v1/devices", headers: b.auth, payload: { name: "PC", platform: "windows", publicKey: key } });
    expect(json(stolen).error.code).toBe("key_in_use");
  });

  it("expired subscriptions lose node access", async () => {
    await seedFleet();
    const u = await signedInUser(t);
    const key = wgKey();
    await t.app.inject({ method: "POST", url: "/v1/devices", headers: u.auth, payload: { name: "PC", platform: "windows", publicKey: key } });
    t.clock.advance(8 * 86_400_000); // trial is 7 days
    const peers = json(await t.app.inject({ method: "GET", url: "/v1/nodes/self/peers", headers: { authorization: `Bearer ${NODE_TOKEN}` } }));
    expect(peers.peers).toHaveLength(0);
    const sub = json(await t.app.inject({ method: "GET", url: "/v1/subscription", headers: u.auth }));
    expect(sub.status).toBe("expired");
  });

  it("reports live connections only while nodes see a handshake", async () => {
    await seedFleet();
    const u = await signedInUser(t);
    const key = wgKey();
    await t.app.inject({ method: "POST", url: "/v1/devices", headers: u.auth, payload: { name: "PC", platform: "windows", publicKey: key } });
    await t.app.inject({ method: "POST", url: "/v1/nodes/self/heartbeat", headers: { authorization: `Bearer ${NODE_TOKEN}` }, payload: { wgHealthy: true, activeKeys: [key] } });
    const live = json(await t.app.inject({ method: "GET", url: "/v1/connections", headers: u.auth }));
    expect(live).toEqual([expect.objectContaining({ serverId: "de-fra-001" })]);
  });
});

describe("network", () => {
  it("reports the caller's address and admits missing GeoIP", async () => {
    const res = json(await t.app.inject({ method: "GET", url: "/v1/network/ip", remoteAddress: "203.0.113.7" }));
    expect(res.ip).toBe("203.0.113.7");
    expect(res.country).toBeNull();
  });
});
