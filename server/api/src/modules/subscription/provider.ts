import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB, SubscriptionStatus } from "../../db/schema.js";

/**
 * Payment providers sit behind this interface; routes never talk to a
 * provider directly. A provider either activates a plan immediately
 * (`manual`) or hands back a hosted page and confirms through webhooks
 * (`stripe`).
 */
export interface Plan {
  id: string;
  name: string;
  period: "trial" | "month" | "year";
  price_cents: number;
  currency: string;
  device_limit: number;
  stripe_price_id?: string | null;
}

export type CheckoutResult = { kind: "redirect"; url: string } | { kind: "activated" };

/** A subscription change a webhook caused, for notifying the user. */
export interface SubscriptionChange {
  userId: string;
  from: SubscriptionStatus | null;
  to: SubscriptionStatus;
}

export class WebhookSignatureError extends Error {}

export interface BillingProvider {
  readonly name: "manual" | "stripe";
  checkout(db: Kysely<DB>, userId: string, plan: Plan, now: Date): Promise<CheckoutResult>;
  /** Hosted page to manage the payment method, invoices and plan; null when the provider has none. */
  portal(db: Kysely<DB>, userId: string): Promise<string | null>;
  /** Cancels at the end of the paid period (never retroactively). */
  cancelAtPeriodEnd(db: Kysely<DB>, userId: string): Promise<void>;
  resume(db: Kysely<DB>, userId: string): Promise<void>;
  /** Before an account is deleted: stop all future charges. Throws if that can't be confirmed. */
  closeAccount(db: Kysely<DB>, userId: string): Promise<void>;
  /**
   * Verifies and applies one webhook delivery, exactly once per event id.
   * Throws `WebhookSignatureError` for deliveries that don't verify; any
   * other error means "not applied, retry".
   */
  handleWebhook(db: Kysely<DB>, headers: Record<string, string | string[] | undefined>, rawBody: string, now: Date): Promise<SubscriptionChange | null>;
}

export function periodEnd(plan: Plan, from: Date): Date {
  const d = new Date(from);
  if (plan.period === "trial") d.setUTCDate(d.getUTCDate() + 7);
  else if (plan.period === "month") d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

/**
 * Staff-granted plans and development. Activation takes no payment, so the
 * invoice it records says exactly that, with a zero amount.
 */
export class ManualBilling implements BillingProvider {
  readonly name = "manual" as const;

  async checkout(db: Kysely<DB>, userId: string, plan: Plan, now: Date): Promise<CheckoutResult> {
    const end = periodEnd(plan, now);
    await db
      .insertInto("billing.subscriptions")
      .values({
        user_id: userId,
        plan_id: plan.id,
        status: "active",
        current_period_start: now,
        current_period_end: end,
        provider: this.name,
      })
      .onConflict((oc) =>
        oc.column("user_id").doUpdateSet({
          plan_id: plan.id,
          status: "active",
          current_period_start: now,
          current_period_end: end,
          cancel_at_period_end: false,
          provider: this.name,
          provider_ref: null,
          updated_at: now,
        }),
      )
      .execute();
    await db
      .insertInto("billing.invoices")
      .values({
        user_id: userId,
        number: `M-${now.getUTCFullYear()}-${randomBytes(4).toString("hex").toUpperCase()}`,
        description: `${plan.name} — granted without payment (manual billing)`,
        amount_cents: 0,
        currency: plan.currency,
        status: "paid",
        paid_at: now,
      })
      .execute();
    return { kind: "activated" };
  }

  async portal(): Promise<string | null> {
    return null;
  }

  async cancelAtPeriodEnd(db: Kysely<DB>, userId: string): Promise<void> {
    await db.updateTable("billing.subscriptions").set({ cancel_at_period_end: true, updated_at: new Date() }).where("user_id", "=", userId).execute();
  }

  async resume(db: Kysely<DB>, userId: string): Promise<void> {
    await db.updateTable("billing.subscriptions").set({ cancel_at_period_end: false, updated_at: new Date() }).where("user_id", "=", userId).execute();
  }

  async closeAccount(): Promise<void> {}

  async handleWebhook(): Promise<SubscriptionChange | null> {
    throw new WebhookSignatureError("manual billing has no webhooks");
  }
}

// ── Stripe ──────────────────────────────────────────────────────────────

/** Pinned so object shapes don't change under us (current_period_* lives on items). */
export const STRIPE_API_VERSION = "2025-03-31.basil";
const SIGNATURE_TOLERANCE_S = 300;
/** Stripe statuses with access (trialing/active/past_due) keep their name; the rest map to ours. */
const STATUS: Record<string, SubscriptionStatus> = {
  incomplete: "incomplete",
  incomplete_expired: "expired",
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  unpaid: "expired",
  paused: "expired",
  canceled: "canceled",
};

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, any> };
}

interface StripeSubscription {
  id: string;
  status: string;
  customer: string;
  cancel_at_period_end: boolean;
  metadata?: Record<string, string>;
  current_period_start?: number;
  current_period_end?: number;
  items: { data: { price: { id: string }; current_period_start?: number; current_period_end?: number }[] };
  default_payment_method?: { id: string; card?: { brand: string; last4: string; exp_month: number; exp_year: number } } | string | null;
}

export interface StripeOptions {
  secretKey: string;
  webhookSecret: string;
  /** Where Stripe sends the browser back to (this API's /v1/billing/return). */
  publicBaseUrl: string;
  fetch?: typeof fetch;
  apiBase?: string;
}

/**
 * Stripe: hosted Checkout and Customer Portal, subscription state from
 * webhooks. On every relevant event the current subscription is fetched
 * from Stripe rather than trusted from the payload, so deliveries that
 * arrive late or out of order can't roll state back.
 */
export class StripeBilling implements BillingProvider {
  readonly name = "stripe" as const;

  constructor(private readonly opts: StripeOptions) {}

  private async api<T>(method: "GET" | "POST" | "DELETE", path: string, form?: Record<string, string>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.opts.secretKey}`, "stripe-version": STRIPE_API_VERSION };
    if (form) headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.apiBase ?? "https://api.stripe.com"}/v1/${path}`, {
      method,
      headers,
      body: form ? new URLSearchParams(form) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) throw new Error(`Stripe ${method} ${path.split("?")[0]} failed (${res.status}): ${json.error?.message ?? "no message"}`);
    return json;
  }

  private async customerFor(db: Kysely<DB>, userId: string): Promise<string> {
    const found = await db.selectFrom("billing.customers").select("customer_ref").where("user_id", "=", userId).where("provider", "=", this.name).executeTakeFirst();
    if (found) return found.customer_ref;
    const user = await db.selectFrom("identity.users").select("email").where("id", "=", userId).executeTakeFirstOrThrow();
    // The idempotency key makes concurrent first purchases share one customer.
    const customer = await this.api<{ id: string }>("POST", "customers", { email: user.email, "metadata[user_id]": userId }, `customer-${userId}`);
    await db
      .insertInto("billing.customers")
      .values({ user_id: userId, provider: this.name, customer_ref: customer.id })
      .onConflict((oc) => oc.columns(["user_id", "provider"]).doNothing())
      .execute();
    return customer.id;
  }

  private async currentRef(db: Kysely<DB>, userId: string): Promise<{ ref: string; status: SubscriptionStatus } | null> {
    const row = await db
      .selectFrom("billing.subscriptions")
      .select(["provider_ref", "status"])
      .where("user_id", "=", userId)
      .where("provider", "=", this.name)
      .executeTakeFirst();
    return row?.provider_ref ? { ref: row.provider_ref, status: row.status } : null;
  }

  async checkout(db: Kysely<DB>, userId: string, plan: Plan): Promise<CheckoutResult> {
    if (!plan.stripe_price_id) throw new Error(`no Stripe price is configured for plan ${plan.id} (STRIPE_PRICE_${plan.id.toUpperCase()})`);
    // A running subscription changes plan in the portal; a second checkout
    // would start a second subscription and charge twice.
    const current = await this.currentRef(db, userId);
    if (current && ["incomplete", "trialing", "active", "past_due"].includes(current.status)) {
      const url = await this.portal(db, userId);
      if (url) return { kind: "redirect", url };
    }
    const customer = await this.customerFor(db, userId);
    const session = await this.api<{ url: string }>("POST", "checkout/sessions", {
      mode: "subscription",
      customer,
      client_reference_id: userId,
      "line_items[0][price]": plan.stripe_price_id,
      "line_items[0][quantity]": "1",
      "subscription_data[metadata][user_id]": userId,
      "subscription_data[metadata][plan_id]": plan.id,
      "metadata[user_id]": userId,
      allow_promotion_codes: "true",
      success_url: `${this.opts.publicBaseUrl}/v1/billing/return?result=success`,
      cancel_url: `${this.opts.publicBaseUrl}/v1/billing/return?result=cancel`,
    });
    return { kind: "redirect", url: session.url };
  }

  async portal(db: Kysely<DB>, userId: string): Promise<string | null> {
    const customer = await this.customerFor(db, userId);
    const session = await this.api<{ url: string }>("POST", "billing_portal/sessions", {
      customer,
      return_url: `${this.opts.publicBaseUrl}/v1/billing/return?result=portal`,
    });
    return session.url;
  }

  private async setCancelAtPeriodEnd(db: Kysely<DB>, userId: string, cancel: boolean): Promise<void> {
    const current = await this.currentRef(db, userId);
    if (!current) {
      await db.updateTable("billing.subscriptions").set({ cancel_at_period_end: cancel, updated_at: new Date() }).where("user_id", "=", userId).execute();
      return;
    }
    const sub = await this.api<StripeSubscription>("POST", `subscriptions/${current.ref}?expand[]=default_payment_method`, { cancel_at_period_end: String(cancel) });
    // Apply the answer now; the webhook that follows will find nothing new.
    const write = await this.prepareSubscription(db, sub, userId, new Date());
    if (write) await db.transaction().execute(write.apply);
  }

  cancelAtPeriodEnd(db: Kysely<DB>, userId: string): Promise<void> {
    return this.setCancelAtPeriodEnd(db, userId, true);
  }

  resume(db: Kysely<DB>, userId: string): Promise<void> {
    return this.setCancelAtPeriodEnd(db, userId, false);
  }

  async closeAccount(db: Kysely<DB>, userId: string): Promise<void> {
    const current = await this.currentRef(db, userId);
    if (current && current.status !== "canceled" && current.status !== "expired") {
      // Immediate cancellation: nobody is charged for a deleted account.
      await this.api("DELETE", `subscriptions/${current.ref}`);
    }
  }

  /** `Stripe-Signature: t=…,v1=…[,v1=…]`: HMAC-SHA256 over `t.body`; any v1 may match (secret rotation). */
  private verify(headers: Record<string, string | string[] | undefined>, rawBody: string, now: Date): StripeEvent {
    const header = String(headers["stripe-signature"] ?? "");
    let t = "";
    const v1: string[] = [];
    for (const part of header.split(",")) {
      const [k, v] = part.split("=", 2);
      if (k === "t" && v) t = v;
      if (k === "v1" && v) v1.push(v);
    }
    const ts = Number(t);
    if (!t || !Number.isFinite(ts) || Math.abs(now.getTime() / 1000 - ts) > SIGNATURE_TOLERANCE_S) {
      throw new WebhookSignatureError("missing timestamp or outside tolerance");
    }
    const expected = createHmac("sha256", this.opts.webhookSecret).update(`${t}.${rawBody}`).digest();
    const ok = v1.some((sig) => {
      const given = Buffer.from(sig, "hex");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
    if (!ok) throw new WebhookSignatureError("signature mismatch");
    return JSON.parse(rawBody) as StripeEvent;
  }

  async handleWebhook(db: Kysely<DB>, headers: Record<string, string | string[] | undefined>, rawBody: string, now: Date): Promise<SubscriptionChange | null> {
    const event = this.verify(headers, rawBody, now);
    const seen = await db.selectFrom("billing.webhook_events").select("event_id").where("provider", "=", this.name).where("event_id", "=", event.id).executeTakeFirst();
    if (seen) return null;

    // Read what's needed from Stripe first; the database transaction below
    // then only writes.
    const o = event.data.object;
    let write: { apply: (tx: Transaction<DB>) => Promise<void>; change: SubscriptionChange | null } | null = null;
    switch (event.type) {
      case "checkout.session.completed":
        if (o.mode === "subscription" && o.subscription) {
          const hint = o.client_reference_id ?? o.metadata?.user_id ?? null;
          if (hint && o.customer) {
            await db
              .insertInto("billing.customers")
              .values({ user_id: hint, provider: this.name, customer_ref: String(o.customer) })
              .onConflict((oc) => oc.columns(["user_id", "provider"]).doNothing())
              .execute();
          }
          write = await this.prepareSubscription(db, await this.fetchSubscription(String(o.subscription)), hint, now);
        }
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        write = await this.prepareSubscription(db, await this.fetchSubscription(String(o.id)), null, now);
        break;
      case "invoice.paid":
        write = await this.prepareInvoice(db, o);
        break;
      case "invoice.payment_failed": {
        const ref = invoiceSubscription(o);
        if (ref) write = await this.prepareSubscription(db, await this.fetchSubscription(ref), null, now);
        break;
      }
      default:
        break;
    }

    let applied = false;
    await db.transaction().execute(async (tx) => {
      const fresh = await tx
        .insertInto("billing.webhook_events")
        .values({ provider: this.name, event_id: event.id, event_type: event.type })
        .onConflict((oc) => oc.doNothing())
        .executeTakeFirst();
      if (Number(fresh.numInsertedOrUpdatedRows ?? 0) === 0) return; // a concurrent delivery won
      if (write) await write.apply(tx);
      applied = true;
    });
    return applied ? (write?.change ?? null) : null;
  }

  private fetchSubscription(ref: string): Promise<StripeSubscription> {
    return this.api<StripeSubscription>("GET", `subscriptions/${encodeURIComponent(ref)}?expand[]=default_payment_method`);
  }

  private async userFor(db: Kysely<DB>, sub: StripeSubscription, hint: string | null): Promise<string | null> {
    if (sub.metadata?.user_id) return sub.metadata.user_id;
    const byCustomer = await db.selectFrom("billing.customers").select("user_id").where("provider", "=", this.name).where("customer_ref", "=", sub.customer).executeTakeFirst();
    return byCustomer?.user_id ?? hint;
  }

  private async prepareSubscription(db: Kysely<DB>, sub: StripeSubscription, hint: string | null, fetchedAt: Date) {
    const userId = await this.userFor(db, sub, hint);
    if (!userId) return null;
    const user = await db.selectFrom("identity.users").select("id").where("id", "=", userId).executeTakeFirst();
    if (!user) return null; // account deleted; nothing to update
    const item = sub.items.data[0];
    const price = item?.price.id;
    const plan = price ? await db.selectFrom("billing.plans").select("id").where("stripe_price_id", "=", price).executeTakeFirst() : undefined;
    const planId = plan?.id ?? sub.metadata?.plan_id;
    const start = item?.current_period_start ?? sub.current_period_start;
    const end = item?.current_period_end ?? sub.current_period_end;
    const status = STATUS[sub.status] ?? "expired";
    const previous = await db.selectFrom("billing.subscriptions").select("status").where("user_id", "=", userId).executeTakeFirst();
    if (!planId || !start || !end) throw new Error(`subscription ${sub.id} lacks a known plan or period`);
    const pm = typeof sub.default_payment_method === "object" && sub.default_payment_method?.card ? sub.default_payment_method : null;

    const values = {
      plan_id: planId,
      status,
      current_period_start: new Date(start * 1000),
      current_period_end: new Date(end * 1000),
      cancel_at_period_end: sub.cancel_at_period_end,
      provider: this.name,
      provider_ref: sub.id,
      provider_synced_at: fetchedAt,
      updated_at: fetchedAt,
    };
    return {
      change: previous?.status === status ? null : { userId, from: previous?.status ?? null, to: status },
      apply: async (tx: Transaction<DB>) => {
        await tx
          .insertInto("billing.subscriptions")
          .values({ user_id: userId, ...values })
          .onConflict((oc) =>
            oc
              .column("user_id")
              .doUpdateSet(values)
              // An older read never overwrites a newer one.
              .where(sql<boolean>`billing.subscriptions.provider_synced_at IS NULL OR billing.subscriptions.provider_synced_at <= ${fetchedAt}`),
          )
          .execute();
        if (pm?.card) {
          const card = { provider_ref: pm.id, brand: pm.card.brand, last4: pm.card.last4, exp_month: pm.card.exp_month, exp_year: pm.card.exp_year };
          await tx
            .insertInto("billing.payment_methods")
            .values({ user_id: userId, provider: this.name, ...card })
            .onConflict((oc) => oc.columns(["user_id", "provider"]).doUpdateSet(card))
            .execute();
        }
      },
    };
  }

  private async prepareInvoice(db: Kysely<DB>, inv: Record<string, any>) {
    const customer = await db.selectFrom("billing.customers").select("user_id").where("provider", "=", this.name).where("customer_ref", "=", String(inv.customer)).executeTakeFirst();
    if (!customer) return null;
    const sub = await db.selectFrom("billing.subscriptions").select("id").where("user_id", "=", customer.user_id).executeTakeFirst();
    const paidAt = inv.status_transitions?.paid_at ? new Date(inv.status_transitions.paid_at * 1000) : new Date(inv.created * 1000);
    const line = inv.lines?.data?.[0]?.description;
    return {
      change: null,
      apply: async (tx: Transaction<DB>) => {
        await tx
          .insertInto("billing.invoices")
          .values({
            user_id: customer.user_id,
            subscription_id: sub?.id ?? null,
            number: String(inv.number ?? inv.id),
            description: String(line ?? "Meridian subscription"),
            amount_cents: Number(inv.amount_paid ?? 0),
            currency: String(inv.currency ?? "eur").toUpperCase(),
            status: "paid",
            issued_at: new Date(inv.created * 1000),
            paid_at: paidAt,
            provider_ref: String(inv.id),
            hosted_url: inv.hosted_invoice_url ?? null,
          })
          .onConflict((oc) => oc.column("provider_ref").where("provider_ref", "is not", null).doNothing())
          .execute();
      },
    };
  }
}

/** The subscription an invoice belongs to (moved under `parent` in 2025 API versions). */
function invoiceSubscription(inv: Record<string, any>): string | null {
  const ref = inv.parent?.subscription_details?.subscription ?? inv.subscription;
  return ref ? String(ref) : null;
}
