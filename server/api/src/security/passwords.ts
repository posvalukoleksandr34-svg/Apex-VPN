import { hash, verify, type Options } from "@node-rs/argon2";

/**
 * OWASP 2024 minimum for argon2id: 19 MiB, 2 iterations, 1 lane.
 * (`Algorithm.Argon2id` is an ambient const enum, so its value is spelled out.)
 */
const ARGON2ID = 2;
const OPTIONS: Options = { algorithm: ARGON2ID as Options["algorithm"], memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

/**
 * Hashing a throwaway password when the account doesn't exist keeps sign-in
 * timing identical for known and unknown emails.
 */
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("meridian-timing-equaliser");
  await verifyPassword(await dummyHash, password);
}

const COMMON = new Set([
  "password", "password1", "password123", "123456789", "1234567890", "qwertyuiop", "iloveyou", "letmein123",
  "welcome123", "admin12345", "qwerty123", "passw0rd", "1q2w3e4r5t", "zaq12wsx", "11111111", "12345678",
]);

/** NIST 800-63B style: length over composition rules, plus a deny-list. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < 10) return "password_too_short";
  if (password.length > 128) return "password_too_long";
  if (COMMON.has(password.toLowerCase())) return "password_too_common";
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (local.length >= 4 && password.toLowerCase().includes(local)) return "password_contains_email";
  if (new Set(password).size < 4) return "password_too_simple";
  return null;
}
