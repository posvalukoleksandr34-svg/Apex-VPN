import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { AdminAction, DB, SubscriptionStatus } from "../../db/schema.js";
import { ApiError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { route } from "../../lib/route.js";
import { BillingError } from "../subscription/provider.js";

/**
 * Staff tools (`/v1/admin`, admins only; see requireAdmin). Every change is
 * recorded in ops.admin_actions: who, to which account, what.
 */

const Filter = z.enum(["all", "active", "trialing", "past_due", "canceled", "expired", "none", "banned", "admins"]);

const AdminUser = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(["user", "admin"]),
  isBanned: z.boolean(),
  emailVerified: z.boolean(),
  mfaEnabled: z.boolean(),
  createdAt: z.string(),
  devices: z.number(),
  /** The limit in force (staff override, else the plan's); null without a plan. */
  deviceLimit: z.number().nullable(),
  deviceLimitOverride: z.number().nullable(),
  subscription: z
    .object({
      status: z.enum(["incomplete", "trialing", "active", "past_due", "canceled", "expired"]),
      planId: z.string(),
      planName: z.string(),
      currentPeriodEnd: z.string(),
      cancelAtPeriodEnd: z.boolean(),
      provider: z.string(),
    })
    .nullable(),
});

const Uuid = z.object({ id: z.uuid() });

/** `%`, `_` and `\` match literally in a search. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function adminRoutes(app: FastifyInstance): void {
  const deps = () => app.deps;

  const base = () =>
    deps()
      .database.db.selectFrom("identity.users as u")
      .leftJoin("billing.subscriptions as s", "s.user_id", "u.id")
      .leftJoin("billing.plans as p", "p.id", "s.plan_id");

  const withUserFields = (qb: ReturnType<typeof base>) =>
    qb.select((eb) => [
      "u.id",
      "u.email",
      "u.role",
      "u.is_banned",
      "u.email_verified_at",
      "u.totp_enabled_at",
      "u.created_at",
      "u.device_limit_override",
      "s.status",
      "s.plan_id",
      "s.current_period_end",
      "s.cancel_at_period_end",
      "s.provider",
      "p.name as plan_name",
      "p.device_limit",
      eb
        .selectFrom("ops.devices as d")
        .select((e) => e.fn.countAll<string>().as("n"))
        .whereRef("d.user_id", "=", "u.id")
        .where("d.revoked_at", "is", null)
        .as("devices"),
    ]);

  type Row = Awaited<ReturnType<ReturnType<typeof withUserFields>["executeTakeFirstOrThrow"]>>;

  // The status the user sees: a lapsed period reads as expired (as /v1/subscription does).
  const statusOf = (r: Row): SubscriptionStatus | null => {
    if (!r.status || !r.current_period_end) return null;
    const lapsed = ["trialing", "active", "past_due"].includes(r.status) && new Date(r.current_period_end) <= deps().now();
    return lapsed ? "expired" : r.status;
  };

  const userDto = (r: Row): z.infer<typeof AdminUser> => {
    const status = statusOf(r);
    return {
      id: r.id,
      email: r.email,
      role: r.role,
      isBanned: r.is_banned,
      emailVerified: r.email_verified_at !== null,
      mfaEnabled: r.totp_enabled_at !== null,
      createdAt: new Date(r.created_at).toISOString(),
      devices: Number(r.devices ?? 0),
      deviceLimit: r.device_limit_override ?? r.device_limit ?? null,
      deviceLimitOverride: r.device_limit_override,
      subscription:
        status && r.plan_id
          ? {
              status,
              planId: r.plan_id,
              planName: r.plan_name ?? r.plan_id,
              currentPeriodEnd: new Date(r.current_period_end!).toISOString(),
              cancelAtPeriodEnd: r.cancel_at_period_end ?? false,
              provider: r.provider ?? "manual",
            }
          : null,
    };
  };

  async function target(id: string) {
    const row = await withUserFields(base()).where("u.id", "=", id).executeTakeFirst();
    if (!row) throw notFound("user_not_found");
    return row;
  }

  async function audit(db: Kysely<DB>, adminId: string, targetUserId: string, action: AdminAction, detail: Record<string, unknown> = {}) {
    await db.insertInto("ops.admin_actions").values({ admin_id: adminId, target_user_id: targetUserId, action, detail: JSON.stringify(detail) }).execute();
  }

  function billingFailure(e: unknown): never {
    if (e instanceof BillingError) throw badRequest(e.code, e.message);
    if (e instanceof ApiError) throw e;
    app.log.error({ err: e }, "billing provider call failed");
    throw new ApiError(502, "billing_unavailable", "the payment provider didn't confirm the change; nothing was recorded");
  }

  route(
    app,
    {
      method: "GET",
      url: "/v1/admin/users",
      tag: "admin",
      summary: "Accounts, newest first: search by email or id, filter by subscription state, ban or role.",
      auth: "admin",
      query: z.object({
        q: z.string().trim().max(254).optional(),
        filter: Filter.default("all"),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      }),
      response: z.object({ total: z.number(), page: z.number(), pageSize: z.number(), users: z.array(AdminUser) }),
    },
    async ({ query }) => {
      const now = deps().now();
      const live = ["trialing", "active", "past_due"] as const;
      const where = (qb: ReturnType<typeof base>) => {
        let x = qb;
        if (query.q) {
          const q = query.q;
          x = z.uuid().safeParse(q).success
            ? x.where("u.id", "=", q)
            : x.where(sql<boolean>`u.email ILIKE ${`%${likeEscape(q.toLowerCase())}%`} ESCAPE '\\'`);
        }
        switch (query.filter) {
          case "banned":
            return x.where("u.is_banned", "=", true);
          case "admins":
            return x.where("u.role", "=", "admin");
          case "none":
            return x.where("s.user_id", "is", null);
          case "trialing":
          case "active":
          case "past_due":
            return x.where("s.status", "=", query.filter).where("s.current_period_end", ">", now);
          case "canceled":
            return x.where("s.status", "=", "canceled");
          case "expired":
            return x.where((eb) => eb.or([eb("s.status", "=", "expired"), eb.and([eb("s.status", "in", [...live]), eb("s.current_period_end", "<=", now)])]));
          default:
            return x;
        }
      };
      const total = await where(base()).select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow();
      const rows = await withUserFields(where(base()))
        .orderBy("u.created_at", "desc")
        .orderBy("u.id")
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute();
      return { total: Number(total.n), page: query.page, pageSize: query.pageSize, users: rows.map(userDto) };
    },
  );

  route(
    app,
    {
      method: "GET",
      url: "/v1/admin/users/:id",
      tag: "admin",
      summary: "One account: subscription, devices, invoices (with refunds) and the staff actions taken on it.",
      auth: "admin",
      params: Uuid,
      response: z.object({
        user: AdminUser,
        stripeCustomerUrl: z.string().nullable(),
        devices: z.array(z.object({ id: z.string(), name: z.string(), platform: z.string(), createdAt: z.string(), lastSeenOn: z.string(), connected: z.boolean() })),
        invoices: z.array(
          z.object({
            id: z.string(),
            number: z.string(),
            description: z.string(),
            amountCents: z.number(),
            refundedCents: z.number(),
            currency: z.string(),
            status: z.string(),
            issuedAt: z.string(),
            refundable: z.boolean(),
          }),
        ),
        actions: z.array(z.object({ id: z.string(), action: z.string(), detail: z.record(z.string(), z.unknown()), adminEmail: z.string().nullable(), createdAt: z.string() })),
      }),
    },
    async ({ params }) => {
      const d = deps();
      const { db } = d.database;
      const user = await target(params.id);
      const [devices, invoices, customer, actions] = await Promise.all([
        db.selectFrom("ops.devices").selectAll().where("user_id", "=", params.id).where("revoked_at", "is", null).orderBy("created_at").execute(),
        db.selectFrom("billing.invoices").selectAll().where("user_id", "=", params.id).orderBy("issued_at", "desc").limit(50).execute(),
        db.selectFrom("billing.customers").select("customer_ref").where("user_id", "=", params.id).where("provider", "=", "stripe").executeTakeFirst(),
        db
          .selectFrom("ops.admin_actions as a")
          .leftJoin("identity.users as by", "by.id", "a.admin_id")
          .select(["a.id", "a.action", "a.detail", "a.created_at", "by.email as admin_email"])
          .where("a.target_user_id", "=", params.id)
          .orderBy("a.id", "desc") // insertion order: newest first, no ties
          .limit(50)
          .execute(),
      ]);
      const testMode = /^(sk|rk)_test_/.test(d.config.STRIPE_SECRET_KEY ?? "");
      return {
        user: userDto(user),
        stripeCustomerUrl: customer ? `https://dashboard.stripe.com/${testMode ? "test/" : ""}customers/${customer.customer_ref}` : null,
        devices: devices.map((x) => ({
          id: x.id,
          name: x.name,
          platform: x.platform,
          createdAt: new Date(x.created_at).toISOString(),
          lastSeenOn: String(x.last_seen_on).slice(0, 10),
          connected: d.activePeers.lookup(x.wg_public_key) !== null,
        })),
        invoices: invoices.map((i) => ({
          id: i.id,
          number: i.number,
          description: i.description,
          amountCents: i.amount_cents,
          refundedCents: i.refunded_cents,
          currency: i.currency,
          status: i.status,
          issuedAt: new Date(i.issued_at).toISOString(),
          refundable: i.provider_ref !== null && (i.status === "paid" || i.status === "refunded") && i.refunded_cents < i.amount_cents,
        })),
        actions: actions.map((a) => ({
          id: String(a.id),
          action: a.action,
          detail: (typeof a.detail === "string" ? JSON.parse(a.detail) : a.detail) as Record<string, unknown>,
          adminEmail: a.admin_email,
          createdAt: new Date(a.created_at).toISOString(),
        })),
      };
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/admin/users/:id/ban",
      tag: "admin",
      summary: "Ban or unban an account. A ban signs it out everywhere and its devices stop working within seconds.",
      auth: "admin",
      params: Uuid,
      body: z.object({ banned: z.boolean(), reason: z.string().trim().max(200).optional() }),
      response: AdminUser,
    },
    async ({ auth, params, body }) => {
      const d = deps();
      if (params.id === auth.userId) throw badRequest("cannot_target_self", "you can't ban your own account");
      const before = await target(params.id);
      if (before.is_banned !== body.banned) {
        await d.database.db.transaction().execute(async (tx) => {
          // The ban trigger revokes every session in the same statement.
          await tx.updateTable("identity.users").set({ is_banned: body.banned, updated_at: d.now() }).where("id", "=", params.id).execute();
          await audit(tx, auth.userId, params.id, body.banned ? "ban" : "unban", body.reason ? { reason: body.reason } : {});
        });
        d.peerSet.changed();
      }
      return userDto(await target(params.id));
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/admin/users/:id/devices/reset",
      tag: "admin",
      summary: "Remove every device of an account (freeing all its slots). They're disconnected within seconds.",
      auth: "admin",
      params: Uuid,
      response: z.object({ removed: z.number() }),
    },
    async ({ auth, params }) => {
      const d = deps();
      await target(params.id);
      const removed = await d.database.db.transaction().execute(async (tx) => {
        const rows = await tx.updateTable("ops.devices").set({ revoked_at: d.now() }).where("user_id", "=", params.id).where("revoked_at", "is", null).returning("id").execute();
        await audit(tx, auth.userId, params.id, "reset_devices", { removed: rows.length });
        return rows.length;
      });
      d.peerSet.changed();
      return { removed };
    },
  );

  route(
    app,
    {
      method: "PUT",
      url: "/v1/admin/users/:id/device-limit",
      tag: "admin",
      summary: "Set this account's device limit, or null for the plan's. Devices over a lowered limit stay until removed.",
      auth: "admin",
      params: Uuid,
      body: z.object({ limit: z.number().int().min(0).max(100).nullable() }),
      response: AdminUser,
    },
    async ({ auth, params, body }) => {
      const d = deps();
      const before = await target(params.id);
      await d.database.db.transaction().execute(async (tx) => {
        await tx.updateTable("identity.users").set({ device_limit_override: body.limit, updated_at: d.now() }).where("id", "=", params.id).execute();
        await audit(tx, auth.userId, params.id, "device_limit", { from: before.device_limit_override, to: body.limit });
      });
      return userDto(await target(params.id));
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/admin/users/:id/cancel-subscription",
      tag: "admin",
      summary: "End an account's subscription now: access ends at once and nothing more is charged. Nothing is refunded.",
      auth: "admin",
      params: Uuid,
      response: AdminUser,
    },
    async ({ auth, params }) => {
      const d = deps();
      await target(params.id);
      try {
        await d.billing.cancelNow(d.database.db, params.id, d.now());
      } catch (e) {
        billingFailure(e);
      }
      await audit(d.database.db, auth.userId, params.id, "cancel_subscription");
      d.peerSet.changed();
      return userDto(await target(params.id));
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/admin/invoices/:id/refund",
      tag: "admin",
      summary: "Refund a paid invoice through the payment provider (in full by default), optionally ending the subscription too.",
      auth: "admin",
      params: Uuid,
      body: z.object({ amountCents: z.number().int().min(1).optional(), cancelSubscription: z.boolean().default(false) }),
      response: z.object({ refundedCents: z.number(), status: z.string() }),
    },
    async ({ auth, params, body }) => {
      const d = deps();
      const { db } = d.database;
      const inv = await db.selectFrom("billing.invoices").selectAll().where("id", "=", params.id).executeTakeFirst();
      if (!inv) throw notFound("invoice_not_found");
      const remaining = inv.amount_cents - inv.refunded_cents;
      if (inv.status === "void" || inv.status === "open") throw badRequest("not_refundable", "only paid invoices can be refunded");
      if (remaining <= 0) throw conflict("already_refunded", "this invoice is refunded in full");
      const amount = body.amountCents ?? remaining;
      if (amount > remaining) throw badRequest("refund_too_large", `at most ${remaining} can be refunded`);
      let refunded: number;
      try {
        // Same invoice, same prior refunds, same amount: a repeated click can't refund twice.
        refunded = await d.billing.refund(inv, amount, `refund-${inv.id}-${inv.refunded_cents}-${amount}`);
      } catch (e) {
        billingFailure(e);
      }
      const total = inv.refunded_cents + refunded;
      const status = total >= inv.amount_cents ? "refunded" : inv.status;
      await db.transaction().execute(async (tx) => {
        // Only if nobody recorded a refund meanwhile (the provider saw one request either way).
        await tx
          .updateTable("billing.invoices")
          .set({ refunded_cents: total, status })
          .where("id", "=", inv.id)
          .where("refunded_cents", "=", inv.refunded_cents)
          .execute();
        await audit(tx, auth.userId, inv.user_id, "refund", {
          invoice: inv.number,
          amountCents: refunded,
          currency: inv.currency,
          cancelSubscription: body.cancelSubscription,
        });
      });
      if (body.cancelSubscription) {
        try {
          await d.billing.cancelNow(db, inv.user_id, d.now());
        } catch (e) {
          billingFailure(e);
        }
        await audit(db, auth.userId, inv.user_id, "cancel_subscription", { withRefund: inv.number });
        d.peerSet.changed();
      }
      return { refundedCents: total, status };
    },
  );
}
