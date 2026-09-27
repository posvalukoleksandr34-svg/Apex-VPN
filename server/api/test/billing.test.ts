/**
 * Stripe billing against a fake Stripe API (the provider's `fetch` is
 * injected) and webhooks signed exactly as Stripe signs them. No network,
 * no real account: this proves our side of the contract.
 */
import { createHmac, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StripeBilling } from "../src/modules/subscription/provider.js";
import { json, PASSWORD, signedInUser, testApp, wgKey, type TestApp } from "./helpers.js";

const WEBHOOK_SECRET = "whsec_test_secret";
const PRICE_MONTHLY = "price_monthly_test";
const PRICE_ANNUAL = "price_annual_test";

interface FakeSub {
  id: string;
  status: string;
  customer: string;
  cancel_at_period_end: boolean;
  metadata: Record<string, string>;
  items: { data: { price: { id: string }; current_period_start: number; current_period_end: number }[] };
  default_payment_method: { id: string; card: { brand: string; last4: string; exp_month: number; exp_year: number } } | null;
}

/** Just enough of Stripe's REST API for the adapter, recording every call. */
class FakeStripe {
  calls: { method: string; path: string; form: Record<string, string>; idempotencyKey?: string }[] = [];
  customers = new Map<string, string>(); // idempotency key → customer id
  subs = new Map<string, FakeSub>();
  /** Invoice id → the payment intent that paid it (API 2025-03-31.basil: `invoice.payments`). */
  invoicePayments = new Map<string, string>();
  /** Refunds made, by idempotency key: a repeated key returns the first refund. */
  refunds = new Map<string, { id: string; payment_intent: string; amount: number; status: string }>();
  down = false;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1\//, "");
    const method = init?.method ?? "GET";
    const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    const headers = new Headers(init?.headers);
    this.calls.push({ method, path, form, idempotencyKey: headers.get("idempotency-key") ?? undefined });
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (this.down) return reply(503, { error: { message: "Stripe is having a bad day" } });
    if (method === "POST" && path === "customers") {
      const key = headers.get("idempotency-key") ?? randomBytes(4).toString("hex");
      if (!this.customers.has(key)) this.customers.set(key, `cus_${randomBytes(6).toString("hex")}`);
      return reply(200, { id: this.customers.get(key) });
    }
    if (method === "POST" && path === "checkout/sessions") return reply(200, { id: "cs_1", url: "https://checkout.stripe.test/c/cs_1" });
    if (method === "POST" && path === "billing_portal/sessions") return reply(200, { url: "https://billing.stripe.test/p/session_1" });
    const inv = path.match(/^invoices\/([\w-]+)$/);
    if (inv && method === "GET") {
      const pi = this.invoicePayments.get(inv[1]!);
      if (!pi) return reply(404, { error: { message: "no such invoice" } });
      expect(url.searchParams.getAll("expand[]")).toContain("payments");
      return reply(200, { id: inv[1], payments: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: pi } }] } });
    }
    if (method === "POST" && path === "refunds") {
      const key = headers.get("idempotency-key") ?? randomBytes(4).toString("hex");
      if (!this.refunds.has(key)) {
        this.refunds.set(key, { id: `re_${randomBytes(4).toString("hex")}`, payment_intent: form.payment_intent!, amount: Number(form.amount), status: "succeeded" });
      }
      return reply(200, this.refunds.get(key));
    }
    const m = path.match(/^subscriptions\/([\w-]+)$/);
    if (m) {
      const sub = this.subs.get(m[1]!);
      if (!sub) return reply(404, { error: { message: "no such subscription" } });
      if (method === "POST" && form.cancel_at_period_end) sub.cancel_at_period_end = form.cancel_at_period_end === "true";
      if (method === "DELETE") sub.status = "canceled";
      return reply(200, sub);
    }
    return reply(404, { error: { message: `unhandled ${method} ${path}` } });
  };

  subscribe(customer: string, userId: string | null, over: Partial<FakeSub> = {}): FakeSub {
    const now = Math.floor(Date.parse("2026-09-01T12:00:00Z") / 1000);
    const sub: FakeSub = {
      id: `sub_${randomBytes(6).toString("hex")}`,
      status: "active",
      customer,
      cancel_at_period_end: false,
      metadata: userId ? { user_id: userId, plan_id: "monthly" } : {},
      items: { data: [{ price: { id: PRICE_MONTHLY }, current_period_start: now, current_period_end: now + 30 * 86400 }] },
      default_payment_method: null,
      ...over,
    };
    this.subs.set(sub.id, sub);
    return sub;
  }

  count(method: string, pathPrefix: string) {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(pathPrefix)).length;
  }
}

function signed(payload: unknown, at: Date, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify(payload);
  const t = Math.floor(at.getTime() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return { raw, signature: `t=${t},v1=${v1}` };
}

let t: TestApp;
let stripe: FakeStripe;

async function deliver(event: { id?: string; type: string; object: Record<string, unknown> }, opts: { secret?: string; at?: Date } = {}) {
  const payload = { id: event.id ?? `evt_${randomBytes(6).toString("hex")}`, type: event.type, data: { object: event.object } };
  const { raw, signature } = signed(payload, opts.at ?? t.clock.now, opts.secret);
  return t.app.inject({ method: "POST", url: "/v1/billing/webhooks/stripe", headers: { "stripe-signature": signature, "content-type": "application/json" }, payload: raw });
}

async function customerOf(userId: string) {
  return (await t.deps.database.db.selectFrom("billing.customers").select("customer_ref").where("user_id", "=", userId).executeTakeFirstOrThrow()).customer_ref;
}

const subscription = async (auth: Record<string, string>) => json(await t.app.inject({ method: "GET", url: "/v1/subscription", headers: auth }));
const enroll = (auth: Record<string, string>) =>
  t.app.inject({ method: "POST", url: "/v1/devices", headers: auth, payload: { name: "PC", platform: "windows", publicKey: wgKey() } });

beforeEach(async () => {
  stripe = new FakeStripe();
  t = await testApp({
    billing: new StripeBilling({ secretKey: "sk_test_x", webhookSecret: WEBHOOK_SECRET, fetch: stripe.fetch as typeof fetch }),
    env: { PUBLIC_BASE_URL: "https://api.apexy.test", WEB_APP_URL: "https://app.apexy.test/" },
  });
  await t.deps.database.db.updateTable("billing.plans").set({ stripe_price_id: PRICE_MONTHLY }).where("id", "=", "monthly").execute();
  await t.deps.database.db.updateTable("billing.plans").set({ stripe_price_id: PRICE_ANNUAL }).where("id", "=", "annual").execute();
});

afterEach(async () => {
  await t.close();
});

describe("Stripe checkout", () => {
  it("creates one customer per user and a subscription checkout for the plan's price", async () => {
    const u = await signedInUser(t);
    const first = json(await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "monthly" } }));
    expect(first).toEqual({ kind: "redirect", url: "https://checkout.stripe.test/c/cs_1" });
    await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "annual" } });

    expect(stripe.count("POST", "customers")).toBe(1);
    const sessions = stripe.calls.filter((c) => c.path === "checkout/sessions");
    expect(sessions).toHaveLength(2);
    const customer = await customerOf(u.user.id);
    expect(sessions[0]!.form).toMatchObject({
      mode: "subscription",
      customer,
      client_reference_id: u.user.id,
      "line_items[0][price]": PRICE_MONTHLY,
      "subscription_data[metadata][user_id]": u.user.id,
      success_url: "https://api.apexy.test/v1/billing/return?result=success",
    });
    expect(sessions[1]!.form["line_items[0][price]"]).toBe(PRICE_ANNUAL);
  });

  it("sends web customers back to the dashboard, and app customers to the API's page", async () => {
    const u = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "monthly", returnTo: "web" } });
    const [web] = stripe.calls.filter((c) => c.path === "checkout/sessions");
    expect(web!.form).toMatchObject({
      success_url: "https://app.apexy.test/billing?checkout=success",
      cancel_url: "https://app.apexy.test/billing?checkout=cancel",
    });
    await t.app.inject({ method: "POST", url: "/v1/subscription/portal", headers: u.auth, payload: { returnTo: "web" } });
    await t.app.inject({ method: "POST", url: "/v1/subscription/portal", headers: u.auth });
    const portals = stripe.calls.filter((c) => c.path === "billing_portal/sessions");
    expect(portals.map((c) => c.form.return_url)).toEqual(["https://app.apexy.test/billing", "https://api.apexy.test/v1/billing/return?result=portal"]);
    // Only the two fixed destinations exist: no caller-supplied URL.
    const other = await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "monthly", returnTo: "https://evil.example" } });
    expect(other.statusCode).toBe(400);
  });

  it("sends a subscriber to the billing portal instead of starting a second subscription", async () => {
    const u = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "monthly" } });
    const sub = stripe.subscribe(await customerOf(u.user.id), u.user.id);
    await deliver({ type: "customer.subscription.created", object: { id: sub.id } });

    const again = json(await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "annual" } }));
    expect(again.url).toBe("https://billing.stripe.test/p/session_1");
    expect(stripe.count("POST", "checkout/sessions")).toBe(1);
    const portal = json(await t.app.inject({ method: "POST", url: "/v1/subscription/portal", headers: u.auth }));
    expect(portal.url).toBe("https://billing.stripe.test/p/session_1");
  });
});

describe("Stripe webhooks", () => {
  it("grant access only once the first payment is confirmed", async () => {
    const u = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "monthly" } });
    const sub = stripe.subscribe(await customerOf(u.user.id), u.user.id, { status: "incomplete" });

    expect((await deliver({ type: "customer.subscription.created", object: { id: sub.id, status: "incomplete" } })).statusCode).toBe(200);
    expect((await subscription(u.auth)).status).toBe("incomplete");
    expect(json(await enroll(u.auth)).error.code).toBe("subscription_inactive");

    sub.status = "active";
    sub.default_payment_method = { id: "pm_1", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } };
    await deliver({ type: "customer.subscription.updated", object: { id: sub.id } });
    const now = await subscription(u.auth);
    expect(now).toMatchObject({ status: "active", provider: "stripe", plan: { id: "monthly" }, paymentMethod: { brand: "visa", last4: "4242" } });
    expect(Date.parse(now.currentPeriodEnd)).toBe(sub.items.data[0]!.current_period_end * 1000);
    expect((await enroll(u.auth)).statusCode).toBe(201);

    const notes = await t.deps.database.db.selectFrom("notify.notifications").select("title").where("user_id", "=", u.user.id).execute();
    expect(notes.map((n) => n.title)).toContain("Plan active");
  });

  it("read the state from Stripe, not from the payload", async () => {
    const u = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "monthly" } });
    const sub = stripe.subscribe(await customerOf(u.user.id), u.user.id, { status: "canceled" });
    // The payload claims active; Stripe says canceled. Stripe wins.
    await deliver({ type: "customer.subscription.updated", object: { id: sub.id, status: "active" } });
    expect((await subscription(u.auth)).status).toBe("canceled");
  });

  it("find the user through the customer when metadata is missing", async () => {
    const u = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "monthly" } });
    const sub = stripe.subscribe(await customerOf(u.user.id), null, { items: { data: [{ price: { id: PRICE_ANNUAL }, current_period_start: 1, current_period_end: 2_000_000_000 }] } });
    await deliver({ type: "checkout.session.completed", object: { mode: "subscription", subscription: sub.id, customer: sub.customer, client_reference_id: u.user.id } });
    // Plan comes from the price (changed in the portal), not from metadata.
    expect(await subscription(u.auth)).toMatchObject({ status: "active", plan: { id: "annual" } });
  });

  it("reject bad signatures and stale timestamps", async () => {
    const u = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "monthly" } });
    const sub = stripe.subscribe(await customerOf(u.user.id), u.user.id);
    expect((await deliver({ type: "customer.subscription.created", object: { id: sub.id } }, { secret: "whsec_wrong" })).statusCode).toBe(400);
    expect((await deliver({ type: "customer.subscription.created", object: { id: sub.id } }, { at: new Date(t.clock.now.getTime() - 10 * 60_000) })).statusCode).toBe(400);
    const unsigned = await t.app.inject({ method: "POST", url: "/v1/billing/webhooks/stripe", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(unsigned.statusCode).toBe(400);
    expect((await subscription(u.auth)).provider).toBe("manual"); // still the trial
  });

  it("apply each event once, and record invoices once", async () => {
    const u = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "monthly" } });
    const customer = await customerOf(u.user.id);
    const sub = stripe.subscribe(customer, u.user.id);
    const event = { id: "evt_dup", type: "customer.subscription.created", object: { id: sub.id } };
    await deliver(event);
    const reads = stripe.count("GET", "subscriptions/");
    expect((await deliver(event)).statusCode).toBe(200);
    expect(stripe.count("GET", "subscriptions/")).toBe(reads); // a redelivery doesn't even read

    const invoice = {
      id: "in_1",
      number: "MER-0001",
      customer,
      amount_paid: 999,
      currency: "eur",
      created: 1_788_000_000,
      status_transitions: { paid_at: 1_788_000_100 },
      hosted_invoice_url: "https://invoice.stripe.test/i/in_1",
      lines: { data: [{ description: "Apexy VPN Monthly" }] },
    };
    await deliver({ type: "invoice.paid", object: invoice });
    await deliver({ type: "invoice.paid", object: invoice }); // different event id, same invoice
    const invoices = json(await t.app.inject({ method: "GET", url: "/v1/subscription/invoices", headers: u.auth })).filter((i: { number: string }) => i.number === "MER-0001");
    expect(invoices).toEqual([expect.objectContaining({ amountCents: 999, currency: "EUR", status: "paid", description: "Apexy VPN Monthly" })]);
  });

  it("keep access through a failed payment (grace), and end it when Stripe cancels", async () => {
    const u = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "monthly" } });
    const sub = stripe.subscribe(await customerOf(u.user.id), u.user.id);
    await deliver({ type: "customer.subscription.created", object: { id: sub.id } });

    sub.status = "past_due";
    await deliver({ type: "invoice.payment_failed", object: { id: "in_2", customer: sub.customer, parent: { subscription_details: { subscription: sub.id } } } });
    expect((await subscription(u.auth)).status).toBe("past_due");
    expect((await enroll(u.auth)).statusCode).toBe(201);

    sub.status = "canceled";
    await deliver({ type: "customer.subscription.deleted", object: { id: sub.id } });
    expect((await subscription(u.auth)).status).toBe("canceled");
    expect(json(await enroll(u.auth)).error.code).toBe("subscription_inactive");
  });

  it("never let an older read overwrite a newer one", async () => {
    const u = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "monthly" } });
    const sub = stripe.subscribe(await customerOf(u.user.id), u.user.id, { status: "canceled" });
    t.clock.advance(60 * 60_000);
    await deliver({ type: "customer.subscription.deleted", object: { id: sub.id } });
    // A delivery processed with an earlier read (clock behind) loses.
    sub.status = "active";
    t.clock.advance(-2 * 60 * 60_000);
    await deliver({ type: "customer.subscription.updated", object: { id: sub.id } });
    expect((await subscription(u.auth)).status).toBe("canceled");
  });

  it("answer 500 (so Stripe retries) when the state can't be read, and apply the retry", async () => {
    const u = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "monthly" } });
    const sub = stripe.subscribe(await customerOf(u.user.id), u.user.id);
    stripe.down = true;
    const event = { id: "evt_retry", type: "customer.subscription.created", object: { id: sub.id } };
    expect((await deliver(event)).statusCode).toBe(500);
    stripe.down = false;
    expect((await deliver(event)).statusCode).toBe(200);
    expect((await subscription(u.auth)).status).toBe("active");
  });
});

describe("Stripe cancellation and account deletion", () => {
  it("cancels at period end through Stripe", async () => {
    const u = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "monthly" } });
    const sub = stripe.subscribe(await customerOf(u.user.id), u.user.id);
    await deliver({ type: "customer.subscription.created", object: { id: sub.id } });
    const after = json(await t.app.inject({ method: "POST", url: "/v1/subscription/cancel", headers: u.auth }));
    expect(after).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
    expect(stripe.calls.some((c) => c.method === "POST" && c.path === `subscriptions/${sub.id}` && c.form.cancel_at_period_end === "true")).toBe(true);
  });

  it("stops charges before deleting an account, and keeps the account if it can't", async () => {
    const u = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "monthly" } });
    const sub = stripe.subscribe(await customerOf(u.user.id), u.user.id);
    await deliver({ type: "customer.subscription.created", object: { id: sub.id } });

    stripe.down = true;
    const refused = await t.app.inject({ method: "DELETE", url: "/v1/users/me", headers: u.auth, payload: { password: PASSWORD } });
    expect(refused.statusCode).toBe(502);
    expect(await t.deps.database.db.selectFrom("identity.users").select("id").where("id", "=", u.user.id).executeTakeFirst()).toBeDefined();

    stripe.down = false;
    const gone = await t.app.inject({ method: "DELETE", url: "/v1/users/me", headers: u.auth, payload: { password: PASSWORD } });
    expect(gone.statusCode).toBeLessThan(300);
    expect(stripe.subs.get(sub.id)!.status).toBe("canceled");
    expect(await t.deps.database.db.selectFrom("identity.users").select("id").where("id", "=", u.user.id).executeTakeFirst()).toBeUndefined();
  });
});

describe("staff refunds", () => {
  async function staff() {
    const a = await signedInUser(t, `staff${randomBytes(3).toString("hex")}@example.com`);
    await t.deps.database.db.updateTable("identity.users").set({ role: "admin" }).where("id", "=", a.user.id).execute();
    return a;
  }
  async function paidInvoice(userId: string, amount = 999, ref: string | null = `in_${randomBytes(4).toString("hex")}`) {
    const row = await t.deps.database.db
      .insertInto("billing.invoices")
      .values({ user_id: userId, number: `A-${randomBytes(3).toString("hex")}`, description: "Monthly", amount_cents: amount, currency: "eur", status: "paid", provider_ref: ref, paid_at: t.clock.now })
      .returning(["id", "number"])
      .executeTakeFirstOrThrow();
    if (ref) stripe.invoicePayments.set(ref, `pi_${ref}`);
    return { id: row.id, number: row.number, ref };
  }
  const refund = (by: { auth: Record<string, string> }, id: string, body: Record<string, unknown> = {}) =>
    t.app.inject({ method: "POST", url: `/v1/admin/invoices/${id}/refund`, headers: by.auth, payload: body });

  it("refunds a paid invoice through Stripe, in parts or in full, and records it", async () => {
    const admin = await staff();
    const u = await signedInUser(t);
    const inv = await paidInvoice(u.user.id, 999);

    expect(json(await refund(admin, inv.id, { amountCents: 300 }))).toEqual({ refundedCents: 300, status: "paid" });
    const call = stripe.calls.find((c) => c.path === "refunds")!;
    expect(call.form).toMatchObject({ payment_intent: `pi_${inv.ref}`, amount: "300", reason: "requested_by_customer", "metadata[invoice]": inv.ref });
    expect(call.idempotencyKey).toBe(`refund-${inv.id}-0-300`);

    expect(json(await refund(admin, inv.id, { amountCents: 1000 })).error.code).toBe("refund_too_large");
    expect(json(await refund(admin, inv.id))).toEqual({ refundedCents: 999, status: "refunded" });
    expect((await refund(admin, inv.id)).statusCode).toBe(409);
    expect(stripe.count("POST", "refunds")).toBe(2);

    const detail = json(await t.app.inject({ method: "GET", url: `/v1/admin/users/${u.user.id}`, headers: admin.auth }));
    expect(detail.invoices[0]).toMatchObject({ refundedCents: 999, status: "refunded", refundable: false });
    expect(detail.actions.map((a: { detail: unknown }) => a.detail)).toEqual([
      { invoice: inv.number, amountCents: 699, currency: "eur", cancelSubscription: false },
      { invoice: inv.number, amountCents: 300, currency: "eur", cancelSubscription: false },
    ]);
    expect(json(await t.app.inject({ method: "GET", url: "/v1/subscription/invoices", headers: u.auth }))[0].status).toBe("refunded");
  });

  it("can end the subscription with the refund", async () => {
    const admin = await staff();
    const u = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: u.auth, payload: { planId: "monthly" } });
    const sub = stripe.subscribe(await customerOf(u.user.id), u.user.id);
    await deliver({ type: "customer.subscription.created", object: { id: sub.id } });
    const inv = await paidInvoice(u.user.id);

    expect((await refund(admin, inv.id, { cancelSubscription: true })).statusCode).toBe(200);
    expect(stripe.subs.get(sub.id)!.status).toBe("canceled");
    expect(json(await t.app.inject({ method: "GET", url: "/v1/subscription", headers: u.auth })).status).toBe("canceled");
    expect(json(await enroll(u.auth)).error.code).toBe("subscription_inactive");
  });

  it("refuses what Stripe didn't charge, and records nothing when Stripe is down", async () => {
    const admin = await staff();
    const u = await signedInUser(t);
    const free = await paidInvoice(u.user.id, 999, null);
    expect(json(await refund(admin, free.id)).error.code).toBe("not_refundable");

    const inv = await paidInvoice(u.user.id);
    stripe.down = true;
    const res = await refund(admin, inv.id);
    expect(res.statusCode).toBe(502);
    expect(json(res).error.code).toBe("billing_unavailable");
    const row = await t.deps.database.db.selectFrom("billing.invoices").select(["refunded_cents", "status"]).where("id", "=", inv.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ refunded_cents: 0, status: "paid" });
    expect(await t.deps.database.db.selectFrom("ops.admin_actions").select("id").where("action", "=", "refund").execute()).toEqual([]);
  });

  it("is for staff only", async () => {
    const u = await signedInUser(t);
    const inv = await paidInvoice(u.user.id);
    expect((await refund(u, inv.id)).statusCode).toBe(403);
    expect(stripe.count("POST", "refunds")).toBe(0);
  });
});

describe("billing return page", () => {
  it("is static and speaks the browser's language", async () => {
    const res = await t.app.inject({ method: "GET", url: "/v1/billing/return?result=success", headers: { "accept-language": "ru-RU,ru;q=0.9,en;q=0.8" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("Оплата получена");
    expect(res.body).not.toContain("<script");
  });
});
