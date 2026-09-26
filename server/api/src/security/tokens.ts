import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import type { Ed25519Keys } from "./keys.js";

export interface AccessClaims {
  /** user id */
  sub: string;
  /** session id */
  sid: string;
  /** how the session authenticated: pwd, or pwd + otp */
  amr: string[];
}

const ISSUER = "meridian";
const AUDIENCE = "meridian-app";

export async function issueAccessToken(keys: Ed25519Keys, claims: AccessClaims, ttlSeconds: number): Promise<string> {
  return new SignJWT({ sid: claims.sid, amr: claims.amr })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(keys.privateKey);
}

export async function verifyAccessToken(keys: Ed25519Keys, token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, keys.publicKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["EdDSA"],
    });
    if (typeof payload.sub !== "string" || typeof payload.sid !== "string") return null;
    return { sub: payload.sub, sid: payload.sid, amr: Array.isArray(payload.amr) ? (payload.amr as string[]) : [] };
  } catch {
    return null;
  }
}

/** Opaque 256-bit token; only its hash is stored. */
export function newOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Short-lived, single-purpose token used between password and OTP steps. */
export async function issueMfaToken(keys: Ed25519Keys, userId: string): Promise<string> {
  return new SignJWT({ purpose: "mfa" })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience("meridian-mfa")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}

export async function verifyMfaToken(keys: Ed25519Keys, token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, keys.publicKey, {
      issuer: ISSUER,
      audience: "meridian-mfa",
      algorithms: ["EdDSA"],
    });
    return payload.purpose === "mfa" && typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

/** Numeric code for email verification / password reset. */
export function numericCode(digits = 6): string {
  const n = randomBytes(4).readUInt32BE(0) % 10 ** digits;
  return n.toString().padStart(digits, "0");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
