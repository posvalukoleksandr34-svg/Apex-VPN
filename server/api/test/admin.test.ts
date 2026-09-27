/**
 * Staff tools: only admins get in (checked against the database on every
 * request), and every change is recorded.
 */
import { afterEach, describe, expect, it } from "vitest";
import { json, PASSWORD, signedInUser, testApp, wgKey, type TestApp } from "./helpers.js";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

type Signed = Awaited<ReturnType<typeof signedInUser>>;

async function makeAdmin(app: TestApp): Promise<Signed> {
  const a = await signedInUser(app, `admin${Date.now()}@example.com`);
  await app.deps.database.db.updateTable("identity.users").set({ role: "admin" }).where("id", "=", a.user.id).execute();
  return a;
}

const enroll = (app: TestApp, u: Signed) =>
  app.app.inject({ method: "POST", url: "/v1/devices", headers: u.auth, payload: { name: "Phone", platform: "ios", publicKey: wgKey() } });

const detail = async (app: TestApp, admin: Signed, id: string) =>
  json(await app.app.inject({ method: "GET", url: `/v1/admin/users/${id}`, headers: admin.auth }));

describe("access", () => {
  it("is for admins only, and a demotion takes effect at once", async () => {
    t = await testApp();
    const user = await signedInUser(t);
    expect((await t.app.inject({ method: "GET", url: "/v1/admin/users" })).statusCode).toBe(401);
    const refused = await t.app.inject({ method: "GET", url: "/v1/admin/users", headers: user.auth });
    expect(refused.statusCode).toBe(403);
    expect(json(refused).error.code).toBe("admin_only");

    const admin = await makeAdmin(t);
    expect((await t.app.inject({ method: "GET", url: "/v1/admin/users", headers: admin.auth })).statusCode).toBe(200);
    expect(json(await t.app.inject({ method: "GET", url: "/v1/users/me", headers: admin.auth })).role).toBe("admin");

    // The same token, after the role is taken away in the database.
    await t.deps.database.db.updateTable("identity.users").set({ role: "user" }).where("id", "=", admin.user.id).execute();
    expect((await t.app.inject({ method: "GET", url: "/v1/admin/users", headers: admin.auth })).statusCode).toBe(403);
  });

  it("can require two-step verification for admins", async () => {
    t = await testApp({ env: { ADMIN_REQUIRE_MFA: "true" } });
    const admin = await makeAdmin(t);
    const res = await t.app.inject({ method: "GET", url: "/v1/admin/users", headers: admin.auth });
    expect(res.statusCode).toBe(403);
    expect(json(res).error.code).toBe("admin_mfa_required");
    await t.deps.database.db.updateTable("identity.users").set({ totp_enabled_at: new Date() }).where("id", "=", admin.user.id).execute();
    expect((await t.app.inject({ method: "GET", url: "/v1/admin/users", headers: admin.auth })).statusCode).toBe(200);
  });
});

describe("accounts", () => {
  it("lists, searches and filters them with devices and subscription", async () => {
    t = await testApp();
    const admin = await makeAdmin(t);
    const paying = await signedInUser(t, "paying.customer@example.com");
    await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: paying.auth, payload: { planId: "monthly" } });
    await enroll(t, paying);
    await enroll(t, paying);
    const trial = await signedInUser(t, "trial_user@example.com");

    const list = async (qs: string) => json(await t!.app.inject({ method: "GET", url: `/v1/admin/users${qs}`, headers: admin.auth }));

    const all = await list("");
    expect(all.total).toBe(3);
    const row = all.users.find((u: { email: string }) => u.email === "paying.customer@example.com");
    expect(row).toMatchObject({ devices: 2, deviceLimit: 5, deviceLimitOverride: null, isBanned: false, subscription: { status: "active", planId: "monthly", provider: "manual" } });

    expect((await list("?q=PAYING")).users.map((u: { email: string }) => u.email)).toEqual(["paying.customer@example.com"]);
    // `_` and `%` are literal in a search, not wildcards.
    expect((await list("?q=trial_")).users.map((u: { email: string }) => u.email)).toEqual(["trial_user@example.com"]);
    expect((await list("?q=%25")).total).toBe(0);
    expect((await list(`?q=${trial.user.id}`)).users.map((u: { id: string }) => u.id)).toEqual([trial.user.id]);
    expect((await list("?filter=active")).users.map((u: { email: string }) => u.email)).toEqual(["paying.customer@example.com"]);
    expect((await list("?filter=admins")).users.map((u: { id: string }) => u.id)).toEqual([admin.user.id]);
    expect((await list("?pageSize=2&page=2")).users).toHaveLength(1);

    // A lapsed period reads as expired, as the user sees it.
    t.clock.advance(40 * 86_400_000);
    expect((await list("?filter=expired")).total).toBe(3);
  });

  it("bans take effect at once, can be lifted, and are recorded", async () => {
    t = await testApp();
    const admin = await makeAdmin(t);
    const user = await signedInUser(t);
    const self = await t.app.inject({ method: "POST", url: `/v1/admin/users/${admin.user.id}/ban`, headers: admin.auth, payload: { banned: true } });
    expect(json(self).error.code).toBe("cannot_target_self");

    const banned = json(await t.app.inject({ method: "POST", url: `/v1/admin/users/${user.user.id}/ban`, headers: admin.auth, payload: { banned: true, reason: "chargeback fraud" } }));
    expect(banned.isBanned).toBe(true);
    expect((await t.app.inject({ method: "GET", url: "/v1/users/me", headers: user.auth })).statusCode).toBe(401);
    expect(json(await t.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: PASSWORD } })).error.code).toBe("account_disabled");

    await t.app.inject({ method: "POST", url: `/v1/admin/users/${user.user.id}/ban`, headers: admin.auth, payload: { banned: false } });
    expect((await t.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: PASSWORD } })).statusCode).toBe(200);

    const { actions } = await detail(t, admin, user.user.id);
    expect(actions.map((a: { action: string }) => a.action)).toEqual(["unban", "ban"]);
    expect(actions[1]).toMatchObject({ detail: { reason: "chargeback fraud" }, adminEmail: admin.email });
  });

  it("removing every device frees the slots and ends their access", async () => {
    t = await testApp();
    const admin = await makeAdmin(t);
    const user = await signedInUser(t);
    await enroll(t, user);
    await enroll(t, user);
    expect(json(await enroll(t, user)).error.code).toBe("device_limit_reached"); // the trial's 2

    const res = json(await t.app.inject({ method: "POST", url: `/v1/admin/users/${user.user.id}/devices/reset`, headers: admin.auth }));
    expect(res).toEqual({ removed: 2 });
    expect(json(await t.app.inject({ method: "GET", url: "/v1/devices", headers: user.auth }))).toEqual([]);
    expect((await enroll(t, user)).statusCode).toBe(201);
    expect((await detail(t, admin, user.user.id)).actions[0]).toMatchObject({ action: "reset_devices", detail: { removed: 2 } });
  });

  it("sets a device limit for one account, and resets it to the plan's", async () => {
    t = await testApp();
    const admin = await makeAdmin(t);
    const user = await signedInUser(t);
    const setLimit = (limit: number | null) =>
      t!.app.inject({ method: "PUT", url: `/v1/admin/users/${user.user.id}/device-limit`, headers: admin.auth, payload: { limit } });

    expect(json(await setLimit(3))).toMatchObject({ deviceLimit: 3, deviceLimitOverride: 3 });
    for (let i = 0; i < 3; i++) expect((await enroll(t, user)).statusCode).toBe(201);
    expect(json(await enroll(t, user)).error.code).toBe("device_limit_reached");
    expect(json(await t.app.inject({ method: "GET", url: "/v1/subscription", headers: user.auth })).deviceLimit).toBe(3);

    expect(json(await setLimit(null))).toMatchObject({ deviceLimit: 2, deviceLimitOverride: null });
    expect(json(await enroll(t, user)).error.code).toBe("device_limit_reached");
    expect((await setLimit(101)).statusCode).toBe(400);
    expect((await detail(t, admin, user.user.id)).actions.map((a: { detail: unknown }) => a.detail)).toEqual([
      { from: 3, to: null },
      { from: null, to: 3 },
    ]);
  });

  it("ends a subscription at once, which ends node access", async () => {
    t = await testApp();
    const admin = await makeAdmin(t);
    const user = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: user.auth, payload: { planId: "monthly" } });
    const res = json(await t.app.inject({ method: "POST", url: `/v1/admin/users/${user.user.id}/cancel-subscription`, headers: admin.auth }));
    expect(res.subscription.status).toBe("canceled");
    expect(json(await t.app.inject({ method: "GET", url: "/v1/subscription", headers: user.auth })).status).toBe("canceled");
    expect(json(await enroll(t, user)).error.code).toBe("subscription_inactive");
  });

  it("answers 404 for an account that doesn't exist", async () => {
    t = await testApp();
    const admin = await makeAdmin(t);
    const res = await t.app.inject({ method: "GET", url: "/v1/admin/users/00000000-0000-4000-8000-000000000000", headers: admin.auth });
    expect(res.statusCode).toBe(404);
  });
});
