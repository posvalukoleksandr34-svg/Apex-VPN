import "server-only";
import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** The account API as this server reaches it: a private address in production. */
  API_INTERNAL_URL: z
    .string()
    .url()
    .default("http://127.0.0.1:8787")
    .transform((v) => v.replace(/\/+$/, "")),
  /** 32 random bytes, base64. Encrypts the session cookie; changing it signs everyone out. */
  WEB_SESSION_SECRET: z.string().refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded"),
  /** Where the Windows installer is published (optional; shown on the overview). */
  DOWNLOAD_URL_WINDOWS: z.string().url().optional(),
});

export type WebEnv = z.infer<typeof Env>;

/** Every variable the dashboard reads (the templates in env/ must list them all). */
export const WEB_ENV_KEYS: readonly string[] = Object.keys(Env.shape);

let cached: WebEnv | undefined;

/** Read on first use, so a build doesn't need the runtime secrets. */
export function env(): WebEnv {
  if (!cached) {
    const parsed = Env.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Invalid web configuration:\n${issues}\nFor development run \`npm run dev:keys -w server/api\`.`);
    }
    cached = parsed.data;
  }
  return cached;
}

export function sessionSecret(): Uint8Array {
  return new Uint8Array(Buffer.from(env().WEB_SESSION_SECRET, "base64"));
}

/** Secure cookies (and the __Host- prefix) everywhere but local development. */
export function secureCookies(): boolean {
  return env().NODE_ENV === "production";
}
