import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ed25519FromSeed, signDetached, verifyDetached } from "../src/security/keys.js";
import { passwordProblem } from "../src/security/passwords.js";
import { SecretBox } from "../src/security/secretbox.js";
import { base32Decode, base32Encode, hotp, verifyTotp } from "../src/security/totp.js";

describe("TOTP", () => {
  const secret = Buffer.from("12345678901234567890");

  it("matches the RFC 6238 SHA-1 test vectors (last 6 digits)", () => {
    // T = 59 s → 94287082, T = 1111111109 → 07081804, T = 1234567890 → 89005924
    expect(hotp(secret, Math.floor(59 / 30))).toBe("287082");
    expect(hotp(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(hotp(secret, Math.floor(1234567890 / 30))).toBe("005924");
  });

  it("accepts one step of drift and nothing more", () => {
    const b32 = base32Encode(secret);
    const now = 1_234_567_890_000;
    const code = hotp(secret, Math.floor(now / 30_000));
    expect(verifyTotp(b32, code, now)).not.toBeNull();
    expect(verifyTotp(b32, code, now + 30_000)).not.toBeNull();
    expect(verifyTotp(b32, code, now + 90_000)).toBeNull();
    expect(verifyTotp(b32, "12345", now)).toBeNull();
  });

  it("base32 round-trips", () => {
    const b = randomBytes(20);
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  });
});

describe("SecretBox", () => {
  const box = new SecretBox(randomBytes(32).toString("base64"));

  it("round-trips and binds the context", () => {
    const sealed = box.seal("JBSWY3DPEHPK3PXP", "totp:user-1");
    expect(box.open(sealed, "totp:user-1")).toBe("JBSWY3DPEHPK3PXP");
    expect(() => box.open(sealed, "totp:user-2")).toThrow();
  });

  it("detects tampering", () => {
    const sealed = Buffer.from(box.seal("secret", "c"), "base64");
    sealed[sealed.length - 1]! ^= 1;
    expect(() => box.open(sealed.toString("base64"), "c")).toThrow();
  });
});

describe("password policy", () => {
  it("prefers length and rejects the obvious", () => {
    expect(passwordProblem("short", "a@b.c")).toBe("password_too_short");
    expect(passwordProblem("password123", "a@b.c")).toBe("password_too_common");
    expect(passwordProblem("aaaaaaaaaaaa", "a@b.c")).toBe("password_too_simple");
    expect(passwordProblem("alexander-rocks-2026", "alexander@example.com")).toBe("password_contains_email");
    expect(passwordProblem("correct horse battery staple", "me@example.com")).toBeNull();
  });
});

describe("Ed25519 relay signing", () => {
  it("derives the raw public key and verifies detached signatures", () => {
    const keys = ed25519FromSeed(randomBytes(32).toString("base64"));
    expect(Buffer.from(keys.publicKeyBase64, "base64")).toHaveLength(32);
    const data = Buffer.from('{"version":1}');
    const sig = signDetached(keys, data);
    expect(verifyDetached(keys, data, sig)).toBe(true);
    expect(verifyDetached(keys, Buffer.from('{"version":2}'), sig)).toBe(false);
  });

  it("matches RFC 8032 test vector 1", () => {
    const seed = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
    const keys = ed25519FromSeed(seed.toString("base64"));
    expect(Buffer.from(keys.publicKeyBase64, "base64").toString("hex")).toBe(
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    );
    expect(signDetached(keys, Buffer.alloc(0)).toString("hex")).toBe(
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    );
  });
});
