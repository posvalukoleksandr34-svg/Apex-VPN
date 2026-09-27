import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { json, signedInUser, testApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeEach(async () => (t = await testApp()));
afterEach(async () => t.close());

describe("billing", () => {
  it("activates via the manual provider with an honest zero-amount invoice", async () => {
    const u = await signedInUser(t);
    const plans = json(await t.app.inject({ method: "GET", url: "/v1/subscription/plans" }));
    expect(plans.map((p: { id: string }) => p.id)).toEqual(["monthly", "annual"]);

    const checkout = json(await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "annual" } }));
    expect(checkout.kind).toBe("activated");
    const sub = json(await t.app.inject({ method: "GET", url: "/v1/subscription", headers: u.auth }));
    expect(sub.status).toBe("active");
    expect(sub.plan.id).toBe("annual");
    expect(sub.paymentMethod).toBeNull();

    const invoices = json(await t.app.inject({ method: "GET", url: "/v1/subscription/invoices", headers: u.auth }));
    expect(invoices[0].amountCents).toBe(0);
    expect(invoices[0].description).toMatch(/without payment/);
  });

  it("cancels at period end without cutting access short, and resumes", async () => {
    const u = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "monthly" } });
    const cancelled = json(await t.app.inject({ method: "POST", url: "/v1/subscription/cancel", headers: u.auth }));
    expect(cancelled.status).toBe("active");
    expect(cancelled.cancelAtPeriodEnd).toBe(true);
    const resumed = json(await t.app.inject({ method: "POST", url: "/v1/subscription/resume", headers: u.auth }));
    expect(resumed.cancelAtPeriodEnd).toBe(false);
  });

  it("refuses unknown plans and unsigned webhooks", async () => {
    const u = await signedInUser(t);
    const res = await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "trial" } });
    expect(json(res).error.code).toBe("unknown_plan");
    const hook = await t.app.inject({ method: "POST", url: "/v1/billing/webhooks/stripe", payload: {} });
    expect(hook.statusCode).toBe(404); // not the configured provider
  });
});

describe("notifications", () => {
  it("records sign-ins and security events; read state and preferences", async () => {
    const u = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/users/me/password", headers: u.auth, payload: { currentPassword: "correct horse battery staple", newPassword: "another long passphrase here" } });
    const list = json(await t.app.inject({ method: "GET", url: "/v1/notifications", headers: u.auth }));
    expect(list.map((n: { type: string }) => n.type)).toEqual(expect.arrayContaining(["new_login", "security"]));
    await t.app.inject({ method: "POST", url: "/v1/notifications/read-all", headers: u.auth });
    const after = json(await t.app.inject({ method: "GET", url: "/v1/notifications", headers: u.auth }));
    expect(after.every((n: { readAt: string | null }) => n.readAt)).toBe(true);

    const prefs = json(await t.app.inject({ method: "GET", url: "/v1/notifications/preferences", headers: u.auth }));
    expect(prefs.newLogin).toBe(true);
    const updated = json(await t.app.inject({ method: "PUT", url: "/v1/notifications/preferences", headers: u.auth, payload: { ...prefs, updates: false } }));
    expect(updated.updates).toBe(false);
  });
});

describe("support", () => {
  it("creates a ticket with an attachment and a diagnostics report", async () => {
    const u = await signedInUser(t);
    const report = json(await t.app.inject({
      method: "POST",
      url: "/v1/diagnostics/reports",
      headers: u.auth,
      payload: { appVersion: "0.1.0", os: "windows 10.0.26200", report: { checks: [{ id: "tunnel", status: "failed" }] } },
    }));
    const boundary = "----apexy";
    const part = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const body =
      part("subject", "Can't connect on hotel Wi-Fi") +
      part("category", "connection") +
      part("description", "Handshake times out on the hotel network since yesterday.") +
      part("diagnosticReportId", report.id) +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="log.txt"\r\nContent-Type: text/plain\r\n\r\nhandshake timeout\r\n--${boundary}--\r\n`;
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/support/tickets",
      headers: { ...u.auth, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const ticket = json(res);
    const detail = json(await t.app.inject({ method: "GET", url: `/v1/support/tickets/${ticket.id}`, headers: u.auth }));
    expect(detail.messages).toHaveLength(1);
    expect(detail.attachments[0]).toMatchObject({ filename: "log.txt", contentType: "text/plain" });
  });

  it("is honest that the DNS leak probe isn't deployed", async () => {
    const res = await t.app.inject({ method: "GET", url: "/v1/diagnostics/dns-leak/abcdefghijklmnop" });
    expect(res.statusCode).toBe(501);
    expect(json(res).error.code).toBe("dns_probe_not_deployed");
  });
});

describe("account", () => {
  it("deletes the account and everything with it", async () => {
    const u = await signedInUser(t);
    const res = await t.app.inject({ method: "DELETE", url: "/v1/users/me", headers: u.auth, payload: { password: "correct horse battery staple" } });
    expect(res.statusCode).toBe(204);
    const users = await t.deps.database.db.selectFrom("identity.users").select("id").execute();
    expect(users).toHaveLength(0);
    const subs = await t.deps.database.db.selectFrom("billing.subscriptions").select("id").execute();
    expect(subs).toHaveLength(0);
  });
});

describe("rate limiting", () => {
  it("limits sign-in attempts per client", async () => {
    const limited = await testApp({ rateLimits: true });
    try {
      let last = 0;
      for (let i = 0; i < 12; i++) {
        last = (await limited.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "x@example.com", password: "whatever-long" } })).statusCode;
      }
      expect(last).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
