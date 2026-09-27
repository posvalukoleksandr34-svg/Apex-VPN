import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest, tooMany, unauthorized } from "../../lib/errors.js";
import { route } from "../../lib/route.js";
import { burnPasswordCheck, hashPassword, passwordProblem, verifyPassword } from "../../security/passwords.js";
import { constantTimeEqual, issueMfaToken, sha256, verifyMfaToken } from "../../security/tokens.js";
import { verifyTotp } from "../../security/totp.js";
import { notify } from "../notifications/notify.js";
import { periodEnd } from "../subscription/provider.js";
import { consumeCode, issueCode } from "./emailCodes.js";
import { revokeAllSessions, revokeFamily, rotateSession, startSession } from "./sessions.js";

export const Email = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const Password = z.string().min(1).max(128);
const Locale = z.enum(["en", "ru", "de", "it"]);
export const DeviceHint = z
  .object({
    name: z.string().trim().min(1).max(64),
    platform: z.enum(["windows", "macos", "linux", "other"]),
  })
  .default({ name: "Unknown device", platform: "other" });

const UserDtoSchema = z.object({
  id: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  locale: z.string(),
  mfaEnabled: z.boolean(),
  createdAt: z.string(),
});
export const TokenResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number(),
  sessionId: z.string(),
  user: UserDtoSchema,
});
const Accepted = z.object({ status: z.literal("accepted") });

const LOCK_AFTER = 10;
const LOCK_MINUTES = 15;

export function authRoutes(app: FastifyInstance): void {
  const deps = () => app.deps;

  route(
    app,
    {
      method: "POST",
      url: "/v1/auth/register",
      tag: "auth",
      summary: "Create an account. Always answers 202 (no account enumeration); a verification code is emailed.",
      auth: "none",
      rateLimit: 10,
      body: z.object({ email: Email, password: Password, locale: Locale.default("en") }),
      response: Accepted,
      status: 202,
    },
    async ({ body }) => {
      const d = deps();
      const problem = passwordProblem(body.password, body.email);
      if (problem) throw badRequest(problem);
      const { db } = d.database;
      const existing = await db.selectFrom("identity.users").select(["id", "email"]).where((eb) => eb(eb.fn("lower", ["email"]), "=", body.email)).executeTakeFirst();
      if (existing) {
        await d.mailer.send(existing.email, { kind: "registration_attempt" });
        return { status: "accepted" as const };
      }
      const now = d.now();
      const user = await db
        .insertInto("identity.users")
        .values({ email: body.email, password_hash: await hashPassword(body.password), locale: body.locale })
        .returning("id")
        .executeTakeFirstOrThrow();
      const trial = await db.selectFrom("billing.plans").selectAll().where("id", "=", "trial").executeTakeFirstOrThrow();
      await db
        .insertInto("billing.subscriptions")
        .values({
          user_id: user.id,
          plan_id: trial.id,
          status: "trialing",
          current_period_start: now,
          current_period_end: periodEnd(trial, now),
          provider: "manual",
        })
        .execute();
      const code = await issueCode(d, user.id, "verify_email");
      await d.mailer.send(body.email, { kind: "verify_email", code });
      return { status: "accepted" as const };
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/auth/verify-email",
      tag: "auth",
      summary: "Confirm an email address with the emailed code.",
      auth: "none",
      rateLimit: 20,
      body: z.object({ email: Email, code: z.string().regex(/^\d{6}$/) }),
      response: z.object({ verified: z.literal(true) }),
    },
    async ({ body }) => {
      const d = deps();
      const user = await findByEmail(body.email);
      if (!user || !(await consumeCode(d, user.id, "verify_email", body.code))) throw badRequest("invalid_code");
      await d.database.db.updateTable("identity.users").set({ email_verified_at: d.now(), updated_at: d.now() }).where("id", "=", user.id).execute();
      return { verified: true as const };
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/auth/resend-verification",
      tag: "auth",
      summary: "Email a new verification code (202 regardless of account existence).",
      auth: "none",
      rateLimit: 5,
      body: z.object({ email: Email }),
      response: Accepted,
      status: 202,
    },
    async ({ body }) => {
      const d = deps();
      const user = await findByEmail(body.email);
      if (user && !user.email_verified_at) {
        const code = await issueCode(d, user.id, "verify_email");
        await d.mailer.send(user.email, { kind: "verify_email", code });
      }
      return { status: "accepted" as const };
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/auth/login",
      tag: "auth",
      summary: "Sign in. Returns tokens, or an MFA challenge when two-factor authentication is on.",
      auth: "none",
      rateLimit: 10,
      body: z.object({ email: Email, password: Password, device: DeviceHint }),
      response: z.union([TokenResponse, z.object({ mfaRequired: z.literal(true), mfaToken: z.string() })]),
    },
    async ({ body }) => {
      const d = deps();
      const user = await findByEmail(body.email);
      if (!user) {
        await burnPasswordCheck(body.password);
        throw unauthorized("invalid_credentials");
      }
      const now = d.now();
      if (user.locked_until && new Date(user.locked_until) > now) {
        throw tooMany("too_many_attempts", Math.ceil((new Date(user.locked_until).getTime() - now.getTime()) / 1000));
      }
      if (!(await verifyPassword(user.password_hash, body.password))) {
        const failures = user.failed_logins + 1;
        await d.database.db
          .updateTable("identity.users")
          .set(failures >= LOCK_AFTER
            ? { failed_logins: 0, locked_until: new Date(now.getTime() + LOCK_MINUTES * 60_000) }
            : { failed_logins: failures })
          .where("id", "=", user.id)
          .execute();
        throw unauthorized("invalid_credentials");
      }
      if (user.is_banned) throw unauthorized("account_disabled");
      await d.database.db.updateTable("identity.users").set({ failed_logins: 0, locked_until: null }).where("id", "=", user.id).execute();
      if (user.totp_enabled_at) {
        return { mfaRequired: true as const, mfaToken: await issueMfaToken(d.keys.access, user.id) };
      }
      return startSession(d, user.id, body.device, ["pwd"]);
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/auth/login/mfa",
      tag: "auth",
      summary: "Complete sign-in with a TOTP code or a one-time recovery code.",
      auth: "none",
      rateLimit: 10,
      body: z
        .object({
          mfaToken: z.string(),
          code: z.string().regex(/^\d{6}$/).optional(),
          recoveryCode: z.string().trim().max(32).optional(),
          device: DeviceHint,
        })
        .refine((b) => !!b.code !== !!b.recoveryCode, "send exactly one of code or recoveryCode"),
      response: TokenResponse,
    },
    async ({ body }) => {
      const d = deps();
      const userId = await verifyMfaToken(d.keys.access, body.mfaToken);
      if (!userId) throw unauthorized("mfa_token_invalid");
      const { db } = d.database;
      const user = await db.selectFrom("identity.users").selectAll().where("id", "=", userId).executeTakeFirst();
      if (!user?.totp_secret_enc || !user.totp_enabled_at) throw unauthorized("mfa_not_enabled");
      if (body.code) {
        const secret = d.box.open(user.totp_secret_enc, `totp:${user.id}`);
        const step = verifyTotp(secret, body.code, d.now().getTime());
        // Each code works once, even within its 30-second window.
        if (step === null || (user.totp_last_step !== null && step <= Number(user.totp_last_step))) {
          throw unauthorized("invalid_code");
        }
        await db.updateTable("identity.users").set({ totp_last_step: step }).where("id", "=", user.id).execute();
      } else {
        const normalized = body.recoveryCode!.toLowerCase().replace(/[^a-z0-9]/g, "");
        const codes = await db.selectFrom("identity.recovery_codes").selectAll().where("user_id", "=", user.id).where("used_at", "is", null).execute();
        const match = codes.find((c) => constantTimeEqual(c.code_hash, sha256(normalized)));
        if (!match) throw unauthorized("invalid_code");
        await db.updateTable("identity.recovery_codes").set({ used_at: d.now() }).where("id", "=", match.id).execute();
        await notify(d, user.id, "security", "Recovery code used", "A recovery code was used to sign in. Generate new codes if you have few left.");
      }
      return startSession(d, user.id, body.device, ["pwd", "otp"]);
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/auth/refresh",
      tag: "auth",
      summary: "Exchange a refresh token for new tokens. The old refresh token stops working; reusing it ends the session.",
      auth: "none",
      rateLimit: 60,
      body: z.object({ refreshToken: z.string().min(20).max(200) }),
      response: TokenResponse,
    },
    async ({ body }) => rotateSession(deps(), body.refreshToken),
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/auth/logout",
      tag: "auth",
      summary: "End the session belonging to this refresh token.",
      auth: "none",
      body: z.object({ refreshToken: z.string().min(20).max(200) }),
    },
    async ({ body }) => {
      const d = deps();
      const row = await d.database.db.selectFrom("identity.sessions").select("family_id").where("refresh_hash", "=", sha256(body.refreshToken)).executeTakeFirst();
      if (row) await revokeFamily(d, row.family_id, "logout");
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/auth/password/forgot",
      tag: "auth",
      summary: "Email a password reset code (202 regardless of account existence).",
      auth: "none",
      rateLimit: 5,
      body: z.object({ email: Email }),
      response: Accepted,
      status: 202,
    },
    async ({ body }) => {
      const d = deps();
      const user = await findByEmail(body.email);
      if (user) {
        const code = await issueCode(d, user.id, "reset_password");
        await d.mailer.send(user.email, { kind: "reset_password", code });
      }
      return { status: "accepted" as const };
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/auth/password/reset",
      tag: "auth",
      summary: "Set a new password with the emailed code. Signs out every session.",
      auth: "none",
      rateLimit: 10,
      body: z.object({ email: Email, code: z.string().regex(/^\d{6}$/), newPassword: Password }),
    },
    async ({ body }) => {
      const d = deps();
      const user = await findByEmail(body.email);
      if (!user) throw badRequest("invalid_code");
      const problem = passwordProblem(body.newPassword, user.email);
      if (problem) throw badRequest(problem);
      if (!(await consumeCode(d, user.id, "reset_password", body.code))) throw badRequest("invalid_code");
      await d.database.db
        .updateTable("identity.users")
        .set({ password_hash: await hashPassword(body.newPassword), failed_logins: 0, locked_until: null, updated_at: d.now(),
          // Receiving the code proves control of the address.
          email_verified_at: user.email_verified_at ?? d.now() })
        .where("id", "=", user.id)
        .execute();
      await revokeAllSessions(d, user.id, "password_reset");
      await notify(d, user.id, "security", "Password changed", "Your password was reset and every session was signed out.");
      await d.mailer.send(user.email, { kind: "password_changed" });
    },
  );

  async function findByEmail(email: string) {
    return deps()
      .database.db.selectFrom("identity.users")
      .selectAll()
      .where((eb) => eb(eb.fn("lower", ["email"]), "=", email))
      .executeTakeFirst();
  }
}
