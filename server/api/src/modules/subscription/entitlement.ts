import type { Kysely } from "kysely";
import type { DB } from "../../db/schema.js";

export interface Entitlement {
  planId: string;
  deviceLimit: number;
  validUntil: Date;
}

/** Trialing, active and past-due (grace) subscriptions entitle to the VPN until their period ends. */
export async function entitlement(db: Kysely<DB>, userId: string, now: Date): Promise<Entitlement | null> {
  const row = await db
    .selectFrom("billing.subscriptions as s")
    .innerJoin("billing.plans as p", "p.id", "s.plan_id")
    .select(["s.plan_id", "s.status", "s.current_period_end", "p.device_limit"])
    .where("s.user_id", "=", userId)
    .executeTakeFirst();
  if (!row) return null;
  if (!["trialing", "active", "past_due"].includes(row.status)) return null;
  const end = new Date(row.current_period_end);
  if (end <= now) return null;
  return { planId: row.plan_id, deviceLimit: row.device_limit, validUntil: end };
}
