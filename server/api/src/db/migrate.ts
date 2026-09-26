import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import type { Database } from "./client.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

/**
 * Forward-only SQL migrations, applied in file-name order, each in its own
 * transaction, recorded in `public.schema_migrations`.
 */
export async function migrate(database: Database, dir = MIGRATIONS_DIR): Promise<string[]> {
  await database.exec(
    "CREATE TABLE IF NOT EXISTS public.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const applied = new Set(
    (await sql<{ version: string }>`SELECT version FROM public.schema_migrations`.execute(database.db)).rows.map(
      (r) => r.version,
    ),
  );
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    const body = readFileSync(join(dir, file), "utf8");
    const escaped = version.replace(/'/g, "''");
    await database.exec(
      `BEGIN;\n${body}\nINSERT INTO public.schema_migrations (version) VALUES ('${escaped}');\nCOMMIT;`,
    );
    ran.push(version);
  }
  return ran;
}
