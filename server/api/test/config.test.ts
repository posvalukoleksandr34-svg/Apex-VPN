import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const key = "a".repeat(43) + "=";

/** A production configuration that should start. */
const production = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://api:secret@db.internal:5432/apexy?sslmode=verify-full",
  PUBLIC_BASE_URL: "https://api.apexy.example",
  WEB_APP_URL: "https://app.apexy.example",
  TRUST_PROXY: "loopback,uniquelocal",
  ACCESS_TOKEN_SEED: key,
  RELAY_SIGNING_SEED: key,
  DATA_ENCRYPTION_KEY: key,
  NODE_PROVISIONING: "agent",
  MAIL_TRANSPORT: "smtp",
  SMTP_URL: "smtps://user:pass@smtp.example.com:465",
  MAIL_FROM: "Apexy VPN <no-reply@apexy.example>",
  BILLING_PROVIDER: "stripe",
  STRIPE_SECRET_KEY: "sk_live_abc",
  STRIPE_WEBHOOK_SECRET: "whsec_abc",
  STRIPE_PRICE_MONTHLY: "price_m",
  STRIPE_PRICE_ANNUAL: "price_a",
};

const refusal = (env: Record<string, string | undefined>) => {
  try {
    loadConfig(env as NodeJS.ProcessEnv);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

describe("production configuration", () => {
  it("starts when complete", () => {
    expect(refusal(production)).toBeNull();
  });

  it.each([
    [{ DATABASE_URL: "pglite://.data/dev" }, /PostgreSQL URL/],
    [{ NODE_PROVISIONING: "wireguard-demo" }, /development-only/],
    [{ MAIL_TRANSPORT: "console" }, /drop real emails/],
    [{ PUBLIC_BASE_URL: "http://api.apexy.example" }, /PUBLIC_BASE_URL must be https/],
    [{ WEB_APP_URL: "http://app.apexy.example" }, /WEB_APP_URL must be https/],
    [{ RATE_LIMIT_ENABLED: "false" }, /rate limiting/],
    [{ STRIPE_WEBHOOK_SECRET: "abc" }, /whsec_/],
    [{ STRIPE_PRICE_ANNUAL: undefined }, /STRIPE_PRICE_MONTHLY and STRIPE_PRICE_ANNUAL/],
  ])("refuses %o", (change, message) => {
    expect(refusal({ ...production, ...change })).toMatch(message);
  });

  it("keeps Stripe's test and live modes apart", () => {
    // Live is the default: a test key is refused unless the deployment says it's staging.
    expect(refusal({ ...production, STRIPE_SECRET_KEY: "sk_test_abc" })).toMatch(/test-mode key but STRIPE_MODE is live/);
    expect(refusal({ ...production, STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_MODE: "test" })).toBeNull();
    expect(refusal({ ...production, STRIPE_SECRET_KEY: "rk_live_abc" })).toBeNull();
    // A live key on a staging deployment is refused too.
    expect(refusal({ ...production, STRIPE_MODE: "test" })).toMatch(/live-mode key but STRIPE_MODE is test/);
    expect(refusal({ ...production, STRIPE_SECRET_KEY: "pk_live_abc" })).toMatch(/isn't a Stripe secret/);
  });
});
