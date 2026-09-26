import { createPrivateKey, createPublicKey, type KeyObject, sign, verify } from "node:crypto";

/** PKCS#8 DER prefix for a raw 32-byte Ed25519 seed. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface Ed25519Keys {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** Raw 32-byte public key, base64 (what clients pin). */
  publicKeyBase64: string;
}

export function ed25519FromSeed(seedBase64: string): Ed25519Keys {
  const seed = Buffer.from(seedBase64, "base64");
  if (seed.length !== 32) throw new Error("Ed25519 seed must be 32 bytes");
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: "jwk" });
  const publicKeyBase64 = Buffer.from(jwk.x ?? "", "base64url").toString("base64");
  return { privateKey, publicKey, publicKeyBase64 };
}

export function signDetached(keys: Ed25519Keys, data: Buffer): Buffer {
  return sign(null, data, keys.privateKey);
}

export function verifyDetached(keys: Ed25519Keys, data: Buffer, signature: Buffer): boolean {
  return verify(null, data, keys.publicKey, signature);
}
