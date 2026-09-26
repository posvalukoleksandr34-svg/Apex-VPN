/**
 * Writes docs/openapi.json from the route registry: the same Zod schemas
 * that validate requests at runtime.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildApp } from "../app.js";
import { createDeps } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { registry } from "../lib/route.js";

const key = () => randomBytes(32).toString("base64");
const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: "pglite://memory",
  ACCESS_TOKEN_SEED: key(),
  RELAY_SIGNING_SEED: key(),
  DATA_ENCRYPTION_KEY: key(),
});
const deps = await createDeps(config);
await buildApp(deps);

const schema = (s: z.ZodType | undefined) => (s ? z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) : undefined);
const paths: Record<string, Record<string, unknown>> = {};
for (const r of registry) {
  const path = r.url.replace(/:(\w+)/g, "{$1}");
  const params = r.params ? Object.keys((r.params as z.ZodObject).shape) : [];
  const query = r.query ? Object.keys((r.query as z.ZodObject).shape) : [];
  paths[path] ??= {};
  paths[path][String(r.method).toLowerCase()] = {
    tags: [r.tag],
    summary: r.summary,
    security: r.auth === "user" ? [{ bearer: [] }] : r.auth === "node" ? [{ nodeToken: [] }] : [],
    parameters: [
      ...params.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })),
      ...query.map((name) => ({ name, in: "query", required: false, schema: { type: "string" } })),
    ],
    requestBody: r.body ? { required: true, content: { "application/json": { schema: schema(r.body) } } } : undefined,
    responses: {
      [String(r.status ?? (r.response ? 200 : 204))]: r.response
        ? { description: "OK", content: { "application/json": { schema: schema(r.response) } } }
        : { description: "No content" },
      default: { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    },
  };
}

const doc = {
  openapi: "3.1.0",
  info: { title: "Meridian API", version: "1", description: "Generated from server/api route definitions. See docs/BACKEND_API.md." },
  servers: [{ url: "https://api.meridianvpn.example" }],
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT (EdDSA, 15 min)" },
      nodeToken: { type: "http", scheme: "bearer", description: "Per-node token (VPN nodes only)" },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: { error: { type: "object", required: ["code"], properties: { code: { type: "string" }, message: { type: "string" }, details: {} } } },
      },
    },
  },
  paths,
};
const out = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".."), "docs", "openapi.json");
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${out} (${registry.length} operations)`);
await deps.database.close();
