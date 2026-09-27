import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, badRequest, notFound, unauthorized } from "../../lib/errors.js";
import { route } from "../../lib/route.js";
import { hashPassword, passwordProblem, verifyPassword } from "../../security/passwords.js";
import { sha256 } from "../../security/tokens.js";
import { newTotpSecret, otpauthUrl, verifyTotp } from "../../security/totp.js";
import { Password } from "../auth/routes.js";
import { revokeAllSessions, revokeFamily } from "../auth/sessions.js";
import { notify } from "../notifications/notify.js";
import { userDto } from "./dto.js";

const UserDtoSchema = z.object({
  id: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  locale: z.string(),
  mfaEnabled: z.boolean(),
  createdAt: z.string(),
});

const SessionDto = z.object({
  id: z.string(),
  deviceName: z.string(),
  platform: z.string(),
  createdAt: z.string(),
  lastUsedOn: z.string(),
  current: z.boolean(),
});

/** Recovery codes: 10 × `xxxx-xxxx`, shown once, stored hashed. */
function recoveryCodes(): string[] {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 10 }, () => {
    const bytes = randomBytes(8);
    const s = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

export function userRoutes(app: FastifyInstance): void {
  const deps = () => app.deps;

  async function loadUser(userId: string) {
    const u = await deps().database.db.selectFrom("identity.users").selectAll().where("id", "=", userId).executeTakeFirst();
    if (!u) throw notFound();
    return u;
  }

  route(app, { method: "GET", url: "/v1/users/me", tag: "users", summary: "The signed-in account.", auth: "user", response: UserDtoSchema },
    async ({ auth }) => userDto(await loadUser(auth.userId)));

  route(
    app,
    {
      method: "PATCH",
      url: "/v1/users/me",
      tag: "users",
      summary: "Update account preferences.",
      auth: "user",
      body: z.object({ locale: z.enum(["en", "ru", "de", "it"]) }),
      response: UserDtoSchema,
    },
    async ({ auth, body }) => {
      await deps().database.db.updateTable("identity.users").set({ locale: body.locale, updated_at: deps().now() }).where("id", "=", auth.userId).execute();
      return userDto(await loadUser(auth.userId));
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/users/me/password",
      tag: "users",
      summary: "Change the password. Signs out every other session.",
      auth: "user",
      rateLimit: 10,
      body: z.object({ currentPassword: Password, newPassword: Password }),
    },
    async ({ auth, body }) => {
      const d = deps();
      const user = await loadUser(auth.userId);
      if (!(await verifyPassword(user.password_hash, body.currentPassword))) throw unauthorized("invalid_credentials");
      const problem = passwordProblem(body.newPassword, user.email);
      if (problem) throw badRequest(problem);
      await d.database.db.updateTable("identity.users").set({ password_hash: await hashPassword(body.newPassword), updated_at: d.now() }).where("id", "=", user.id).execute();
      await revokeAllSessions(d, user.id, "password_changed", auth.sessionId);
      await notify(d, user.id, "security", "Password changed", "Your password was changed. Other sessions were signed out.");
      await d.mailer.send(user.email, { kind: "password_changed" });
    },
  );

  route(
    app,
    {
      method: "DELETE",
      url: "/v1/users/me",
      tag: "users",
      summary: "Delete the account and everything linked to it (devices, sessions, tickets, reports).",
      auth: "user",
      rateLimit: 5,
      body: z.object({ password: Password }),
    },
    async ({ auth, body }) => {
      const user = await loadUser(auth.userId);
      if (!(await verifyPassword(user.password_hash, body.password))) throw unauthorized("invalid_credentials");
      // Stop future charges first; if the provider can't confirm that, the
      // account stays so the user isn't left paying for nothing.
      try {
        await deps().billing.closeAccount(deps().database.db, user.id);
      } catch (e) {
        throw new ApiError(502, "billing_unavailable", `couldn't cancel the subscription: ${(e as Error).message}`);
      }
      await deps().database.db.deleteFrom("identity.users").where("id", "=", user.id).execute();
      deps().peerSet.changed();
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/users/me/mfa/totp/setup",
      tag: "users",
      summary: "Start TOTP enrolment: returns the secret and otpauth URL (not active until confirmed).",
      auth: "user",
      response: z.object({ secret: z.string(), otpauthUrl: z.string() }),
    },
    async ({ auth }) => {
      const d = deps();
      const user = await loadUser(auth.userId);
      if (user.totp_enabled_at) throw badRequest("mfa_already_enabled");
      const secret = newTotpSecret();
      await d.database.db.updateTable("identity.users").set({ totp_secret_enc: d.box.seal(secret, `totp:${user.id}`) }).where("id", "=", user.id).execute();
      return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/users/me/mfa/totp/enable",
      tag: "users",
      summary: "Confirm TOTP with a first code. Returns one-time recovery codes (shown once).",
      auth: "user",
      rateLimit: 10,
      body: z.object({ code: z.string().regex(/^\d{6}$/) }),
      response: z.object({ recoveryCodes: z.array(z.string()) }),
    },
    async ({ auth, body }) => {
      const d = deps();
      const user = await loadUser(auth.userId);
      if (user.totp_enabled_at) throw badRequest("mfa_already_enabled");
      if (!user.totp_secret_enc) throw badRequest("mfa_setup_required");
      const step = verifyTotp(d.box.open(user.totp_secret_enc, `totp:${user.id}`), body.code, d.now().getTime());
      if (step === null) throw badRequest("invalid_code");
      const codes = recoveryCodes();
      await d.database.db.transaction().execute(async (tx) => {
        await tx.updateTable("identity.users").set({ totp_enabled_at: d.now(), totp_last_step: step, updated_at: d.now() }).where("id", "=", user.id).execute();
        await tx.deleteFrom("identity.recovery_codes").where("user_id", "=", user.id).execute();
        await tx
          .insertInto("identity.recovery_codes")
          .values(codes.map((c) => ({ user_id: user.id, code_hash: sha256(c.replace("-", "")) })))
          .execute();
      });
      await notify(d, user.id, "security", "Two-factor authentication on", "Sign-ins now need a code from your authenticator app.");
      await d.mailer.send(user.email, { kind: "mfa_changed", enabled: true });
      return { recoveryCodes: codes };
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/users/me/mfa/totp/disable",
      tag: "users",
      summary: "Turn TOTP off (needs the password and a current code).",
      auth: "user",
      rateLimit: 10,
      body: z.object({ password: Password, code: z.string().regex(/^\d{6}$/) }),
    },
    async ({ auth, body }) => {
      const d = deps();
      const user = await loadUser(auth.userId);
      if (!user.totp_enabled_at || !user.totp_secret_enc) throw badRequest("mfa_not_enabled");
      if (!(await verifyPassword(user.password_hash, body.password))) throw unauthorized("invalid_credentials");
      if (verifyTotp(d.box.open(user.totp_secret_enc, `totp:${user.id}`), body.code, d.now().getTime()) === null) {
        throw badRequest("invalid_code");
      }
      await d.database.db
        .updateTable("identity.users")
        .set({ totp_enabled_at: null, totp_secret_enc: null, totp_last_step: null, updated_at: d.now() })
        .where("id", "=", user.id)
        .execute();
      await d.database.db.deleteFrom("identity.recovery_codes").where("user_id", "=", user.id).execute();
      await notify(d, user.id, "security", "Two-factor authentication off", "Sign-ins no longer need an authenticator code.");
      await d.mailer.send(user.email, { kind: "mfa_changed", enabled: false });
    },
  );

  route(
    app,
    { method: "GET", url: "/v1/users/me/sessions", tag: "users", summary: "Signed-in sessions.", auth: "user", response: z.array(SessionDto) },
    async ({ auth }) => {
      const rows = await deps()
        .database.db.selectFrom("identity.sessions")
        .select(["family_id", "device_name", "platform", "created_at", "last_used_on"])
        .where("user_id", "=", auth.userId)
        .where("revoked_at", "is", null)
        .where("rotated_at", "is", null)
        .where("expires_at", ">", deps().now())
        .orderBy("created_at", "desc")
        .execute();
      return rows.map((r) => ({
        id: r.family_id,
        deviceName: r.device_name,
        platform: r.platform,
        createdAt: new Date(r.created_at).toISOString(),
        lastUsedOn: String(r.last_used_on).slice(0, 10),
        current: r.family_id === auth.sessionId,
      }));
    },
  );

  route(
    app,
    {
      method: "DELETE",
      url: "/v1/users/me/sessions/:id",
      tag: "users",
      summary: "Sign out one session.",
      auth: "user",
      params: z.object({ id: z.uuid() }),
    },
    async ({ auth, params }) => {
      const owned = await deps()
        .database.db.selectFrom("identity.sessions")
        .select("family_id")
        .where("family_id", "=", params.id)
        .where("user_id", "=", auth.userId)
        .executeTakeFirst();
      if (!owned) throw notFound();
      await revokeFamily(deps(), params.id, "user_revoked");
    },
  );

  route(
    app,
    { method: "POST", url: "/v1/users/me/sessions/revoke-others", tag: "users", summary: "Sign out every other session.", auth: "user" },
    async ({ auth }) => revokeAllSessions(deps(), auth.userId, "user_revoked", auth.sessionId),
  );
}
