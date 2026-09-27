import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";
import { createDeps } from "../src/bootstrap.js";
import { loadConfig } from "../src/config.js";
import type { AppDeps } from "../src/deps.js";
import { ConsoleMailer } from "../src/lib/mailer.js";
import type { PeerProvisioner } from "../src/modules/devices/provisioner.js";
import type { BillingProvider } from "../src/modules/subscription/provider.js";

export interface TestApp {
  app: FastifyInstance;
  deps: AppDeps;
  mailer: ConsoleMailer;
  clock: { now: Date; advance(ms: number): void };
  close(): Promise<void>;
}

/** A fresh app on an in-memory PostgreSQL (PGlite) with throwaway keys. */
export async function testApp(
  overrides: { provisioner?: PeerProvisioner; billing?: BillingProvider; rateLimits?: boolean; env?: Record<string, string> } = {},
): Promise<TestApp> {
  const key = () => randomBytes(32).toString("base64");
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://memory",
    ACCESS_TOKEN_SEED: key(),
    RELAY_SIGNING_SEED: key(),
    DATA_ENCRYPTION_KEY: key(),
    UPLOAD_DIR: `.data/test-uploads-${process.pid}`,
    RATE_LIMIT_ENABLED: overrides.rateLimits ? "true" : "false",
    ...overrides.env,
  });
  const mailer = new ConsoleMailer();
  const clock = {
    now: new Date("2026-09-01T12:00:00Z"),
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  const deps = await createDeps(config, { mailer, now: () => clock.now, ...(overrides.provisioner ? { provisioner: overrides.provisioner } : {}), ...(overrides.billing ? { billing: overrides.billing } : {}) });
  const app = await buildApp(deps);
  await app.ready();
  return {
    app,
    deps,
    mailer,
    clock,
    close: async () => {
      await app.close();
      await deps.database.close();
    },
  };
}

export function json<T = any>(res: LightMyRequestResponse): T {
  return JSON.parse(res.body) as T;
}

export function lastCode(mailer: ConsoleMailer, to: string): string {
  for (let i = mailer.sent.length - 1; i >= 0; i--) {
    const m = mailer.sent[i]!;
    if (m.to === to && "code" in m.template) return m.template.code;
  }
  throw new Error(`no code mailed to ${to}`);
}

export const PASSWORD = "correct horse battery staple";

/** Registers, verifies and signs in; returns tokens. */
export async function signedInUser(t: TestApp, email = `user${randomBytes(4).toString("hex")}@example.com`) {
  await t.app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, password: PASSWORD } });
  await t.app.inject({ method: "POST", url: "/v1/auth/verify-email", payload: { email, code: lastCode(t.mailer, email) } });
  const res = await t.app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email, password: PASSWORD, device: { name: "Test PC", platform: "windows" } },
  });
  const body = json(res);
  return { email, ...body, auth: { authorization: `Bearer ${body.accessToken}` } } as {
    email: string;
    accessToken: string;
    refreshToken: string;
    sessionId: string;
    user: { id: string };
    auth: { authorization: string };
  };
}

/** A valid-looking WireGuard public key. */
export function wgKey(): string {
  return randomBytes(32).toString("base64");
}
