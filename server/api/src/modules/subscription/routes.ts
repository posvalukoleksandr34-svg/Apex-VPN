import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest, notFound } from "../../lib/errors.js";
import { route } from "../../lib/route.js";
import { notify } from "../notifications/notify.js";
import { WebhookSignatureError, type SubscriptionChange } from "./provider.js";
import { billingReturnPage } from "./returnPage.js";

const PlanDto = z.object({
  id: z.string(),
  name: z.string(),
  period: z.enum(["trial", "month", "year"]),
  priceCents: z.number(),
  currency: z.string(),
  deviceLimit: z.number(),
});

const SubscriptionDto = z.object({
  status: z.enum(["none", "incomplete", "trialing", "active", "past_due", "canceled", "expired"]),
  plan: PlanDto.nullable(),
  currentPeriodStart: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  provider: z.string().nullable(),
  paymentMethod: z.object({ brand: z.string(), last4: z.string(), expMonth: z.number(), expYear: z.number() }).nullable(),
  devicesUsed: z.number(),
});

export function subscriptionRoutes(app: FastifyInstance): void {
  const deps = () => app.deps;

  const planDto = (p: { id: string; name: string; period: "trial" | "month" | "year"; price_cents: number; currency: string; device_limit: number }) => ({
    id: p.id,
    name: p.name,
    period: p.period,
    priceCents: p.price_cents,
    currency: p.currency,
    deviceLimit: p.device_limit,
  });

  async function current(userId: string): Promise<z.infer<typeof SubscriptionDto>> {
    const { db } = deps().database;
    const sub = await db.selectFrom("billing.subscriptions").selectAll().where("user_id", "=", userId).executeTakeFirst();
    const plan = sub ? await db.selectFrom("billing.plans").selectAll().where("id", "=", sub.plan_id).executeTakeFirst() : undefined;
    const pm = await db.selectFrom("billing.payment_methods").selectAll().where("user_id", "=", userId).where("is_default", "=", true).executeTakeFirst();
    const devices = await db.selectFrom("ops.devices").select((eb) => eb.fn.countAll<string>().as("n")).where("user_id", "=", userId).where("revoked_at", "is", null).executeTakeFirstOrThrow();
    const expired = sub && new Date(sub.current_period_end) <= deps().now() && sub.status !== "canceled";
    return {
      status: !sub ? "none" : expired ? "expired" : sub.status,
      plan: plan ? planDto(plan) : null,
      currentPeriodStart: sub ? new Date(sub.current_period_start).toISOString() : null,
      currentPeriodEnd: sub ? new Date(sub.current_period_end).toISOString() : null,
      cancelAtPeriodEnd: sub?.cancel_at_period_end ?? false,
      provider: sub?.provider ?? null,
      paymentMethod: pm ? { brand: pm.brand, last4: pm.last4, expMonth: pm.exp_month, expYear: pm.exp_year } : null,
      devicesUsed: Number(devices.n),
    };
  }

  route(app, { method: "GET", url: "/v1/subscription", tag: "subscription", summary: "Current plan and billing state.", auth: "user", response: SubscriptionDto },
    async ({ auth }) => current(auth.userId));

  route(app, { method: "GET", url: "/v1/subscription/plans", tag: "subscription", summary: "Plans on offer.", auth: "none", response: z.array(PlanDto) },
    async () => {
      const plans = await deps().database.db.selectFrom("billing.plans").selectAll().where("active", "=", true).where("period", "!=", "trial").orderBy("price_cents").execute();
      return plans.map(planDto);
    });

  route(
    app,
    {
      method: "POST",
      url: "/v1/subscription/checkout",
      tag: "subscription",
      summary: "Start (or change to) a plan. Returns a hosted checkout URL, or `activated` when the provider needs no payment step.",
      auth: "user",
      rateLimit: 10,
      body: z.object({ planId: z.string() }),
      response: z.object({ kind: z.enum(["redirect", "activated"]), url: z.string().optional() }),
    },
    async ({ auth, body }) => {
      const d = deps();
      const plan = await d.database.db.selectFrom("billing.plans").selectAll().where("id", "=", body.planId).where("active", "=", true).executeTakeFirst();
      if (!plan || plan.period === "trial") throw badRequest("unknown_plan");
      const result = await d.billing.checkout(d.database.db, auth.userId, plan, d.now());
      if (result.kind === "activated") {
        await notify(d, auth.userId, "subscription", "Plan active", `Your ${plan.name} plan is active.`);
      }
      return result;
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/subscription/cancel",
      tag: "subscription",
      summary: "Cancel at the end of the paid period. Access continues until then; nothing is refunded or cut short.",
      auth: "user",
      response: SubscriptionDto,
    },
    async ({ auth }) => {
      const d = deps();
      const sub = await d.database.db.selectFrom("billing.subscriptions").select("current_period_end").where("user_id", "=", auth.userId).executeTakeFirst();
      if (!sub) throw notFound("no_subscription");
      await d.billing.cancelAtPeriodEnd(d.database.db, auth.userId);
      await notify(d, auth.userId, "subscription", "Plan cancelled",
        `Your plan stays active until ${new Date(sub.current_period_end).toISOString().slice(0, 10)} and won't renew.`);
      return current(auth.userId);
    },
  );

  route(
    app,
    { method: "POST", url: "/v1/subscription/resume", tag: "subscription", summary: "Undo a pending cancellation.", auth: "user", response: SubscriptionDto },
    async ({ auth }) => {
      await deps().billing.resume(deps().database.db, auth.userId);
      return current(auth.userId);
    },
  );

  route(
    app,
    {
      method: "GET",
      url: "/v1/subscription/invoices",
      tag: "subscription",
      summary: "Invoice history.",
      auth: "user",
      response: z.array(
        z.object({
          id: z.string(),
          number: z.string(),
          description: z.string(),
          amountCents: z.number(),
          currency: z.string(),
          status: z.string(),
          issuedAt: z.string(),
          paidAt: z.string().nullable(),
        }),
      ),
    },
    async ({ auth }) => {
      const rows = await deps().database.db.selectFrom("billing.invoices").selectAll().where("user_id", "=", auth.userId).orderBy("issued_at", "desc").limit(100).execute();
      return rows.map((i) => ({
        id: i.id,
        number: i.number,
        description: i.description,
        amountCents: i.amount_cents,
        currency: i.currency,
        status: i.status,
        issuedAt: new Date(i.issued_at).toISOString(),
        paidAt: i.paid_at ? new Date(i.paid_at).toISOString() : null,
      }));
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/subscription/portal",
      tag: "subscription",
      summary: "A hosted billing page for the payment method, invoices and plan changes (Stripe Customer Portal).",
      auth: "user",
      rateLimit: 10,
      response: z.object({ url: z.string() }),
    },
    async ({ auth }) => {
      const url = await deps().billing.portal(deps().database.db, auth.userId);
      if (!url) throw notFound("no_billing_portal");
      return { url };
    },
  );

  // Where the hosted checkout/portal sends the browser back. The app itself
  // picks up the new state when its window regains focus.
  app.get("/v1/billing/return", async (req, reply) => {
    const { result } = req.query as { result?: string };
    return reply
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .send(billingReturnPage(result === "success" || result === "cancel" ? result : "portal", String(req.headers["accept-language"] ?? "")));
  });

  // Provider webhooks need the raw body for signature checks.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    scope.post("/v1/billing/webhooks/:provider", { config: { rateLimit: false } }, async (req, reply) => {
      const d = deps();
      const { provider } = req.params as { provider: string };
      if (provider !== d.billing.name || d.billing.name === "manual") return reply.status(404).send({ error: { code: "not_found" } });
      let change: SubscriptionChange | null;
      try {
        change = await d.billing.handleWebhook(d.database.db, req.headers, String(req.body ?? ""), d.now());
      } catch (e) {
        if (e instanceof WebhookSignatureError) return reply.status(400).send({ error: { code: "invalid_signature" } });
        // Not applied: the provider retries the delivery.
        req.log.error({ err: e }, "billing webhook not applied");
        return reply.status(500).send({ error: { code: "webhook_failed" } });
      }
      if (change) await notifyChange(change);
      return reply.status(200).send({ received: true });
    });
  });

  async function notifyChange({ userId, to }: SubscriptionChange) {
    const d = deps();
    if (to === "active" || to === "trialing") await notify(d, userId, "subscription", "Plan active", "Your Apexy VPN plan is active. You can connect.");
    else if (to === "past_due") await notify(d, userId, "subscription", "Payment failed", "We couldn't take this period's payment. Update your payment method to keep your plan.");
    else if (to === "canceled" || to === "expired") await notify(d, userId, "subscription", "Plan ended", "Your Apexy VPN plan has ended. Choose a plan to connect again.");
  }
}
