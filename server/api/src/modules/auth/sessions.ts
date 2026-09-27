import { randomUUID } from "node:crypto";
import type { AppDeps } from "../../deps.js";
import { conflict, unauthorized } from "../../lib/errors.js";
import { issueAccessToken, newOpaqueToken, sha256 } from "../../security/tokens.js";
import { notify } from "../notifications/notify.js";
import { userDto, type UserDto } from "../users/dto.js";

export interface DeviceHint {
  name: string;
  platform: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
  user: UserDto;
}

/** A retry that raced its own rotation gets a soft error, not a theft alarm. */
const ROTATION_GRACE_MS = 15_000;

export async function startSession(deps: AppDeps, userId: string, device: DeviceHint, amr: string[]): Promise<TokenResponse> {
  const { db } = deps.database;
  const familyId = randomUUID();
  const refreshToken = newOpaqueToken();
  const now = deps.now();
  await db
    .insertInto("identity.sessions")
    .values({
      user_id: userId,
      family_id: familyId,
      refresh_hash: sha256(refreshToken),
      device_name: device.name,
      platform: device.platform,
      expires_at: new Date(now.getTime() + deps.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    })
    .execute();
  const user = await db.selectFrom("identity.users").selectAll().where("id", "=", userId).executeTakeFirstOrThrow();
  await notify(deps, userId, "new_login", "New sign-in", `Signed in on ${device.name} (${device.platform}).`, {
    sessionId: familyId,
  });
  await deps.mailer.send(user.email, { kind: "new_login", deviceName: device.name, platform: device.platform });
  return {
    accessToken: await issueAccessToken(deps.keys.access, { sub: userId, sid: familyId, amr }, deps.config.ACCESS_TOKEN_TTL_SECONDS),
    refreshToken,
    expiresIn: deps.config.ACCESS_TOKEN_TTL_SECONDS,
    sessionId: familyId,
    user: userDto(user),
  };
}

export async function rotateSession(deps: AppDeps, refreshToken: string): Promise<TokenResponse> {
  const now = deps.now();
  type Outcome = { kind: "ok"; tokens: TokenResponse } | { kind: "reused"; familyId: string; userId: string; deviceName: string };
  const outcome: Outcome = await deps.database.db.transaction().execute(async (tx): Promise<Outcome> => {
    const row = await tx
      .selectFrom("identity.sessions")
      .selectAll()
      .where("refresh_hash", "=", sha256(refreshToken))
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw unauthorized("invalid_token");
    if (row.revoked_at) throw unauthorized("session_revoked");
    if (row.rotated_at) {
      if (now.getTime() - new Date(row.rotated_at).getTime() < ROTATION_GRACE_MS) {
        throw conflict("refresh_in_progress", "this refresh token was just rotated; use the newest one");
      }
      // Revocation happens after this transaction commits (throwing here
      // would roll it back).
      return { kind: "reused", familyId: row.family_id, userId: row.user_id, deviceName: row.device_name };
    }
    if (new Date(row.expires_at) <= now) throw unauthorized("session_expired");

    const next = newOpaqueToken();
    await tx.updateTable("identity.sessions").set({ rotated_at: now }).where("id", "=", row.id).execute();
    await tx
      .insertInto("identity.sessions")
      .values({
        user_id: row.user_id,
        family_id: row.family_id,
        refresh_hash: sha256(next),
        device_name: row.device_name,
        platform: row.platform,
        created_at: row.created_at,
        expires_at: new Date(now.getTime() + deps.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      })
      .execute();
    const user = await tx.selectFrom("identity.users").selectAll().where("id", "=", row.user_id).executeTakeFirstOrThrow();
    if (user.is_banned) throw unauthorized("account_disabled");
    const amr = user.totp_enabled_at ? ["pwd", "otp"] : ["pwd"];
    return {
      kind: "ok",
      tokens: {
        accessToken: await issueAccessToken(deps.keys.access, { sub: user.id, sid: row.family_id, amr }, deps.config.ACCESS_TOKEN_TTL_SECONDS),
        refreshToken: next,
        expiresIn: deps.config.ACCESS_TOKEN_TTL_SECONDS,
        sessionId: row.family_id,
        user: userDto(user),
      },
    };
  });
  if (outcome.kind === "ok") return outcome.tokens;

  // A rotated token came back: it was copied. End the whole sign-in.
  await revokeFamily(deps, outcome.familyId, "refresh_token_reuse");
  await notify(deps, outcome.userId, "security", "Session ended for your safety",
    `A sign-in on ${outcome.deviceName} was ended because its credentials were used twice.`);
  throw unauthorized("token_reused");
}

export async function revokeFamily(deps: AppDeps, familyId: string, reason: string): Promise<void> {
  await deps.database.db
    .updateTable("identity.sessions")
    .set({ revoked_at: deps.now(), revoked_reason: reason })
    .where("family_id", "=", familyId)
    .where("revoked_at", "is", null)
    .execute();
}

export async function revokeAllSessions(deps: AppDeps, userId: string, reason: string, exceptFamily?: string): Promise<void> {
  let q = deps.database.db
    .updateTable("identity.sessions")
    .set({ revoked_at: deps.now(), revoked_reason: reason })
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null);
  if (exceptFamily) q = q.where("family_id", "!=", exceptFamily);
  await q.execute();
}
