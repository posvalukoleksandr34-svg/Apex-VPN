import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hotp, base32Decode } from "../src/security/totp.js";
import { json, lastCode, PASSWORD, signedInUser, testApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeEach(async () => (t = await testApp()));
afterEach(async () => t.close());

const login = (email: string, password = PASSWORD) =>
  t.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password, device: { name: "PC", platform: "windows" } } });

describe("registration", () => {
  it("registers, verifies by code, and starts a trial", async () => {
    const res = await t.app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "New@Example.com", password: PASSWORD } });
    expect(res.statusCode).toBe(202);
    const code = lastCode(t.mailer, "new@example.com");
    const bad = await t.app.inject({ method: "POST", url: "/v1/auth/verify-email", payload: { email: "new@example.com", code: code === "000000" ? "111111" : "000000" } });
    expect(json(bad).error.code).toBe("invalid_code");
    const ok = await t.app.inject({ method: "POST", url: "/v1/auth/verify-email", payload: { email: "new@example.com", code } });
    expect(ok.statusCode).toBe(200);

    const session = json(await login("new@example.com"));
    const sub = json(await t.app.inject({ method: "GET", url: "/v1/subscription", headers: { authorization: `Bearer ${session.accessToken}` } }));
    expect(sub.status).toBe("trialing");
    expect(sub.plan.deviceLimit).toBe(2);
  });

  it("doesn't reveal whether an email is registered", async () => {
    const u = await signedInUser(t);
    const again = await t.app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: u.email, password: PASSWORD } });
    expect(again.statusCode).toBe(202);
    expect(t.mailer.sent.at(-1)?.template.kind).toBe("registration_attempt");

    const unknown = await login("nobody@example.com");
    const wrong = await login(u.email, "wrong password entirely");
    expect(unknown.statusCode).toBe(401);
    expect(json(unknown).error.code).toBe(json(wrong).error.code);
  });

  it("rejects weak passwords", async () => {
    const res = await t.app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "a@example.com", password: "password123" } });
    expect(json(res).error.code).toBe("password_too_common");
  });

  it("locks an account after repeated failures", async () => {
    const u = await signedInUser(t);
    for (let i = 0; i < 10; i++) await login(u.email, "not the password at all");
    const locked = await login(u.email);
    expect(locked.statusCode).toBe(429);
    expect(locked.headers["retry-after"]).toBeDefined();
    t.clock.advance(16 * 60_000);
    expect((await login(u.email)).statusCode).toBe(200);
  });
});

describe("sessions", () => {
  it("rotates refresh tokens and treats reuse as theft", async () => {
    const u = await signedInUser(t);
    const r1 = await t.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: u.refreshToken } });
    expect(r1.statusCode).toBe(200);
    const rotated = json(r1);
    expect(rotated.refreshToken).not.toBe(u.refreshToken);
    expect(rotated.sessionId).toBe(u.sessionId);

    // An immediate retry with the old token is a race, not theft.
    const race = await t.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: u.refreshToken } });
    expect(json(race).error.code).toBe("refresh_in_progress");

    // Later reuse means the token was copied: the whole session ends.
    t.clock.advance(60_000);
    const reuse = await t.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: u.refreshToken } });
    expect(json(reuse).error.code).toBe("token_reused");
    const me = await t.app.inject({ method: "GET", url: "/v1/users/me", headers: { authorization: `Bearer ${rotated.accessToken}` } });
    expect(json(me).error.code).toBe("session_revoked");
    const next = await t.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: rotated.refreshToken } });
    expect(next.statusCode).toBe(401);
  });

  it("lists and revokes sessions; logout ends the session", async () => {
    const u = await signedInUser(t);
    const other = json(await login(u.email));
    const list = json(await t.app.inject({ method: "GET", url: "/v1/users/me/sessions", headers: u.auth }));
    expect(list).toHaveLength(2);
    expect(list.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    await t.app.inject({ method: "DELETE", url: `/v1/users/me/sessions/${other.sessionId}`, headers: u.auth });
    const gone = await t.app.inject({ method: "GET", url: "/v1/users/me", headers: { authorization: `Bearer ${other.accessToken}` } });
    expect(gone.statusCode).toBe(401);

    await t.app.inject({ method: "POST", url: "/v1/auth/logout", payload: { refreshToken: u.refreshToken } });
    expect((await t.app.inject({ method: "GET", url: "/v1/users/me", headers: u.auth })).statusCode).toBe(401);
  });

  it("password reset signs everyone out", async () => {
    const u = await signedInUser(t);
    await t.app.inject({ method: "POST", url: "/v1/auth/password/forgot", payload: { email: u.email } });
    const code = lastCode(t.mailer, u.email);
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/auth/password/reset",
      payload: { email: u.email, code, newPassword: "a brand new long passphrase" },
    });
    expect(res.statusCode).toBe(204);
    expect((await t.app.inject({ method: "GET", url: "/v1/users/me", headers: u.auth })).statusCode).toBe(401);
    expect((await login(u.email, "a brand new long passphrase")).statusCode).toBe(200);
  });
});

describe("two-factor authentication", () => {
  it("enrols, challenges sign-in, blocks replay, and honours recovery codes once", async () => {
    const u = await signedInUser(t);
    const setup = json(await t.app.inject({ method: "POST", url: "/v1/users/me/mfa/totp/setup", headers: u.auth }));
    const secret = base32Decode(setup.secret);
    const codeAt = (d: Date) => hotp(secret, Math.floor(d.getTime() / 30_000));

    const enable = await t.app.inject({ method: "POST", url: "/v1/users/me/mfa/totp/enable", headers: u.auth, payload: { code: codeAt(t.clock.now) } });
    const { recoveryCodes } = json(enable);
    expect(recoveryCodes).toHaveLength(10);

    const challenge = json(await login(u.email));
    expect(challenge.mfaRequired).toBe(true);
    // The enrolment code can't be replayed for sign-in.
    const replay = await t.app.inject({ method: "POST", url: "/v1/auth/login/mfa", payload: { mfaToken: challenge.mfaToken, code: codeAt(t.clock.now) } });
    expect(json(replay).error.code).toBe("invalid_code");

    t.clock.advance(30_000);
    const ok = await t.app.inject({ method: "POST", url: "/v1/auth/login/mfa", payload: { mfaToken: challenge.mfaToken, code: codeAt(t.clock.now) } });
    expect(ok.statusCode).toBe(200);

    const challenge2 = json(await login(u.email));
    const rc = recoveryCodes[0].toUpperCase();
    const viaRecovery = await t.app.inject({ method: "POST", url: "/v1/auth/login/mfa", payload: { mfaToken: challenge2.mfaToken, recoveryCode: rc } });
    expect(viaRecovery.statusCode).toBe(200);
    const challenge3 = json(await login(u.email));
    const reused = await t.app.inject({ method: "POST", url: "/v1/auth/login/mfa", payload: { mfaToken: challenge3.mfaToken, recoveryCode: rc } });
    expect(reused.statusCode).toBe(401);
  });
});
