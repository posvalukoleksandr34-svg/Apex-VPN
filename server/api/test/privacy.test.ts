/**
 * The no-logs policy as tests: nothing records where a user connects from
 * or what they do, and the schema has no place to put it.
 */
import { Writable } from "node:stream";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { json, signedInUser, testApp, wgKey, type TestApp } from "./helpers.js";

let t: TestApp;
beforeEach(async () => {
  t = await testApp();
});
afterEach(async () => {
  await t.close();
});

describe("no-logs", () => {
  it("request logs carry no client address, headers or bodies", async () => {
    const lines: string[] = [];
    const stream = new Writable({ write: (chunk, _enc, done) => (lines.push(String(chunk)), done()) });
    const app = await buildApp(t.deps, { logger: { stream } });
    await app.ready();
    const u = await signedInUser(t);
    await app.inject({ method: "GET", url: "/v1/users/me", headers: u.auth, remoteAddress: "203.0.113.77" });
    await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: u.email, password: "not-this-one" }, remoteAddress: "203.0.113.77" });
    await app.close();

    const log = lines.join("");
    expect(log).toContain('"url":"/v1/users/me"'); // it did log the requests
    expect(log).not.toContain("203.0.113.77");
    expect(log).not.toMatch(/remoteAddress|remotePort/);
    expect(log).not.toContain(u.accessToken);
    expect(log).not.toContain("not-this-one");
    expect(log).not.toContain(u.email);
  });

  it("the schema has no column for client addresses or activity", async () => {
    // Every address-typed or address-named column that exists, and why. A new
    // one fails this test until it's reviewed against the no-logs policy.
    const allowed = new Set([
      "ops.devices.ipv4", // tunnel address the account assigns (routing), not where the user is
      "ops.devices.ipv6",
      "fleet.servers.ipv4", // our own servers
      "fleet.servers.ipv6",
      "fleet.servers.wg_gateway_ipv4",
      "fleet.servers.wg_gateway_ipv6",
      "fleet.servers.wg_dns_ipv4",
      "billing.invoices.hosted_url", // Stripe's page for an invoice (account data, not activity)
    ]);
    const { rows } = await sql<{ col: string; type: string }>`
      SELECT table_schema || '.' || table_name || '.' || column_name AS col, data_type AS type
        FROM information_schema.columns
       WHERE table_schema IN ('identity', 'billing', 'fleet', 'ops', 'diag', 'support', 'notify')
         AND (data_type IN ('inet', 'cidr')
              OR column_name ~ '(^|_)(ip|ipv4|ipv6|addr|address|remote|user_agent|url|query|history|visited)($|_)')`.execute(t.deps.database.db);
    expect(rows.map((r) => r.col).filter((c) => !allowed.has(c))).toEqual([]);
    // Device activity is kept to the day, and only the last one.
    const lastSeen = await sql<{ type: string }>`
      SELECT data_type AS type FROM information_schema.columns WHERE table_schema = 'ops' AND table_name = 'devices' AND column_name = 'last_seen_on'`.execute(t.deps.database.db);
    expect(lastSeen.rows[0]?.type).toBe("date");
  });
});

describe("device limits", () => {
  it("paid plans allow 5 devices", async () => {
    const u = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "monthly" } });
    expect(json(await t.app.inject({ method: "GET", url: "/v1/subscription", headers: u.auth })).plan).toMatchObject({ id: "monthly", deviceLimit: 5 });
    for (let i = 0; i < 5; i++) {
      const ok = await t.app.inject({ method: "POST", url: "/v1/devices", headers: u.auth, payload: { name: `PC ${i}`, platform: "windows", publicKey: wgKey() } });
      expect(ok.statusCode).toBe(201);
    }
    const sixth = await t.app.inject({ method: "POST", url: "/v1/devices", headers: u.auth, payload: { name: "One too many", platform: "windows", publicKey: wgKey() } });
    expect(json(sixth).error.code).toBe("device_limit_reached");
  });
});
