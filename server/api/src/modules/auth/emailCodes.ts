import type { AppDeps } from "../../deps.js";
import { constantTimeEqual, numericCode, sha256 } from "../../security/tokens.js";

type Purpose = "verify_email" | "reset_password";

const TTL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

/** Issues a 6-digit code, invalidating earlier unused ones of the same purpose. */
export async function issueCode(deps: AppDeps, userId: string, purpose: Purpose): Promise<string> {
  const { db } = deps.database;
  const now = deps.now();
  await db
    .updateTable("identity.email_tokens")
    .set({ used_at: now })
    .where("user_id", "=", userId)
    .where("purpose", "=", purpose)
    .where("used_at", "is", null)
    .execute();
  const code = numericCode(6);
  await db
    .insertInto("identity.email_tokens")
    .values({ user_id: userId, purpose, code_hash: sha256(`${userId}:${code}`), expires_at: new Date(now.getTime() + TTL_MS) })
    .execute();
  return code;
}

/** Consumes a code. Five wrong guesses burn it. */
export async function consumeCode(deps: AppDeps, userId: string, purpose: Purpose, code: string): Promise<boolean> {
  const { db } = deps.database;
  const now = deps.now();
  const token = await db
    .selectFrom("identity.email_tokens")
    .selectAll()
    .where("user_id", "=", userId)
    .where("purpose", "=", purpose)
    .where("used_at", "is", null)
    .where("expires_at", ">", now)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  if (!token || token.attempts >= MAX_ATTEMPTS) return false;
  if (!constantTimeEqual(token.code_hash, sha256(`${userId}:${code}`))) {
    await db
      .updateTable("identity.email_tokens")
      .set((eb) => ({ attempts: eb("attempts", "+", 1) }))
      .where("id", "=", token.id)
      .execute();
    return false;
  }
  await db.updateTable("identity.email_tokens").set({ used_at: now }).where("id", "=", token.id).execute();
  return true;
}
