/**
 * What the web dashboard relies on: the client address forwarded by trusted
 * proxies (for rate limits), web returns from billing, and device types for
 * configs set up by hand.
 */
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { json, signedInUser, testApp, wgKey, type TestApp } from "./helpers.js";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const ip = async (app: TestApp, remoteAddress: string, forwarded?: string) =>
  json(await app.app.inject({ method: "GET", url: "/v1/network/ip", remoteAddress, headers: forwarded ? { "x-forwarded-for": forwarded } : {} })).ip;

describe("client address", () => {
  it("believes X-Forwarded-For only from trusted proxies", async () => {
    t = await testApp({ env: { TRUST_PROXY: "127.0.0.1, 10.0.0.0/8" } });
    expect(await ip(t, "127.0.0.1", "203.0.113.9")).toBe("203.0.113.9");
    expect(await ip(t, "10.1.2.3", "198.51.100.4, 10.9.9.9")).toBe("198.51.100.4");
    // A client can't pass itself off as someone else by sending the header.
    expect(await ip(t, "198.51.100.1", "203.0.113.9")).toBe("198.51.100.1");
    expect(await ip(t, "127.0.0.1", "spoofed, 203.0.113.9")).toBe("203.0.113.9");
  });

  it("ignores X-Forwarded-For by default", async () => {
    t = await testApp();
    expect(await ip(t, "198.51.100.1", "203.0.113.9")).toBe("198.51.100.1");
  });

  it("refuses a TRUST_PROXY it can't read", () => {
    const env = { NODE_ENV: "test", ACCESS_TOKEN_SEED: "a".repeat(43) + "=", RELAY_SIGNING_SEED: "a".repeat(43) + "=", DATA_ENCRYPTION_KEY: "a".repeat(43) + "=" };
    expect(() => loadConfig({ ...env, TRUST_PROXY: "the proxy" })).toThrow(/TRUST_PROXY/);
    expect(loadConfig({ ...env, TRUST_PROXY: "loopback,uniquelocal" }).TRUST_PROXY).toEqual(["loopback", "uniquelocal"]);
    expect(loadConfig({ ...env, TRUST_PROXY: "true" }).TRUST_PROXY).toBe(true);
  });
});

describe("web returns", () => {
  it("are refused while the dashboard address isn't configured", async () => {
    t = await testApp();
    const u = await signedInUser(t);
    const res = await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "monthly", returnTo: "web" } });
    expect(res.statusCode).toBe(400);
    expect(json(res).error.code).toBe("web_return_unavailable");
  });
});

describe("device types", () => {
  it("covers phones and routers set up with a config", async () => {
    t = await testApp();
    const u = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "monthly" } }); // the trial allows 2
    for (const platform of ["ios", "android", "router"]) {
      const res = await t.app.inject({ method: "POST", url: "/v1/devices", headers: u.auth, payload: { name: platform, platform, publicKey: wgKey() } });
      expect(res.statusCode, res.body).toBe(201);
      expect(json(res).device.platform).toBe(platform);
    }
    const bad = await t.app.inject({ method: "POST", url: "/v1/devices", headers: u.auth, payload: { name: "x", platform: "toaster", publicKey: wgKey() } });
    expect(bad.statusCode).toBe(400);
  });

  it("names web sign-ins", async () => {
    t = await testApp();
    const u = await signedInUser(t);
    const res = await t.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: u.email, password: "correct horse battery staple", device: { name: "Firefox on Linux", platform: "web" } } });
    expect(res.statusCode).toBe(200);
    const sessions = json(await t.app.inject({ method: "GET", url: "/v1/users/me/sessions", headers: u.auth }));
    expect(sessions.map((s: { platform: string }) => s.platform)).toContain("web");
  });
});

describe("dates", () => {
  it("come back as calendar days, not shifted timestamps", async () => {
    t = await testApp();
    const u = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/devices", headers: u.auth, payload: { name: "PC", platform: "windows", publicKey: wgKey() } });
    const [device] = json(await t.app.inject({ method: "GET", url: "/v1/devices", headers: u.auth }));
    const [session] = json(await t.app.inject({ method: "GET", url: "/v1/users/me/sessions", headers: u.auth }));
    const today = new Date().toISOString().slice(0, 10); // current_date on the (UTC) test database
    expect(device.lastSeenOn).toBe(today);
    expect(session.lastUsedOn).toBe(today);
  });
});
