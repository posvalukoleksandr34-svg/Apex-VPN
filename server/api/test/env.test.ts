/**
 * The settings templates in env/ and the configuration the API reads can't
 * drift apart, and the production template, filled in, is a configuration
 * the API accepts under its production rules.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, loadConfig } from "../src/config.js";

const template = (path: string) => readFileSync(fileURLToPath(new URL(`../../../env/${path}`, import.meta.url)), "utf8");

/** Every variable a template names, set or shown commented as "# NAME=default". */
function named(text: string): string[] {
  return [...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
}

/** The template's settings (not the commented ones), as the API would read them. */
function settings(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1]!, m[2]!]));
}

/** What an operator does after generate.sh: secrets, placeholders and Stripe values filled in. */
function filled(env: Record<string, string>, stripe: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) out[k] = v.replace(/<[a-z][a-z-]*>/g, "x").replaceAll("example.com", "apexy.example");
  for (const k of ["ACCESS_TOKEN_SEED", "RELAY_SIGNING_SEED", "DATA_ENCRYPTION_KEY"]) out[k] = randomBytes(32).toString("base64");
  return { ...out, ...stripe };
}

const stripeLive = { STRIPE_SECRET_KEY: "rk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_ANNUAL: "price_a" };

describe("settings templates", () => {
  const production = template("production/api.env.example");

  it("name every variable the API reads, and nothing else", () => {
    expect([...new Set(named(production))].sort()).toEqual([...CONFIG_KEYS].sort());
    const unknown = named(template("development/api.env.example")).filter((k) => !CONFIG_KEYS.includes(k));
    expect(unknown).toEqual([]);
  });

  it("leave only the secrets, Stripe values and marked placeholders to fill", () => {
    const empty = Object.entries(settings(production)).filter(([, v]) => v === "").map(([k]) => k).sort();
    expect(empty).toEqual(["ACCESS_TOKEN_SEED", "DATA_ENCRYPTION_KEY", "RELAY_SIGNING_SEED", "STRIPE_PRICE_ANNUAL", "STRIPE_PRICE_MONTHLY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
  });

  it("filled in, pass the API's production rules", () => {
    const cfg = loadConfig(filled(settings(production), stripeLive));
    expect(cfg).toMatchObject({ NODE_ENV: "production", NODE_PROVISIONING: "agent", MAIL_TRANSPORT: "smtp", BILLING_PROVIDER: "stripe", STRIPE_MODE: "live" });
    expect(cfg.TRUST_PROXY).toEqual(["loopback", "uniquelocal"]);
  });

  it("filled in for staging (Stripe test mode), pass too; a test key on production doesn't", () => {
    const staging = { ...settings(production), STRIPE_MODE: "test" };
    expect(() => loadConfig(filled(staging, { ...stripeLive, STRIPE_SECRET_KEY: "sk_test_x" }))).not.toThrow();
    expect(() => loadConfig(filled(settings(production), { ...stripeLive, STRIPE_SECRET_KEY: "sk_test_x" }))).toThrow(/test-mode key/);
  });

  it("as generated, aren't accepted until they're filled in", () => {
    expect(() => loadConfig(settings(production))).toThrow();
  });
});
