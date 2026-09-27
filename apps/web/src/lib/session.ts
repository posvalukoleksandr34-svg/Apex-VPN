import { EncryptJWT, jwtDecrypt } from "jose";
import { z } from "zod";
import type { TokenResponse } from "./types";

/**
 * The browser's session: the API's tokens, encrypted (AES-256-GCM) into one
 * httpOnly cookie. Page scripts never see a token; the server decrypts the
 * cookie for each request and calls the API on the user's behalf.
 */
const SessionSchema = z.object({
  /** Access token and when it expires (ms since epoch). */
  at: z.string(),
  atExp: z.number(),
  /** Refresh token (rotated on every use). */
  rt: z.string(),
  sid: z.string(),
  uid: z.string(),
  email: z.string(),
});

export type Session = z.infer<typeof SessionSchema>;

/** How long the browser keeps the cookie. The refresh token's own expiry decides whether it still works. */
export const SESSION_MAX_AGE_S = 60 * 24 * 3600;
/** Tokens are refreshed this long before the access token expires. */
export const REFRESH_AHEAD_MS = 2 * 60_000;

export function sessionCookie(secure: boolean) {
  return {
    // __Host-: sent only over HTTPS, only to this exact host, path /.
    name: secure ? "__Host-apexy" : "apexy",
    options: { httpOnly: true, secure, sameSite: "lax" as const, path: "/", maxAge: SESSION_MAX_AGE_S },
  };
}

export function fromTokens(t: TokenResponse, now = Date.now()): Session {
  return { at: t.accessToken, atExp: now + t.expiresIn * 1000, rt: t.refreshToken, sid: t.sessionId, uid: t.user.id, email: t.user.email };
}

export async function seal(session: Session, secret: Uint8Array, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  return new EncryptJWT({ s: session })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt(iat)
    .setExpirationTime(iat + SESSION_MAX_AGE_S)
    .encrypt(secret);
}

/** The session, or null for anything that doesn't decrypt, has expired or doesn't fit. */
export async function unseal(value: string, secret: Uint8Array, now = Date.now()): Promise<Session | null> {
  try {
    const { payload } = await jwtDecrypt(value, secret, { currentDate: new Date(now), keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"] });
    const parsed = SessionSchema.safeParse(payload.s);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function needsRefresh(session: Session, now = Date.now()): boolean {
  return session.atExp - now < REFRESH_AHEAD_MS;
}
