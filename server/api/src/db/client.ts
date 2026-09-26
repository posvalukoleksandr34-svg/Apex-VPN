import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DB } from "./schema.js";

/**
 * The database handle. Production uses PostgreSQL through `pg`; development
 * and tests use PGlite (PostgreSQL compiled to WASM, same SQL dialect), so
 * nothing needs Docker to run.
 */
export interface Database {
  db: Kysely<DB>;
  /** Runs a multi-statement SQL script (migrations). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export async function openDatabase(url: string): Promise<Database> {
  if (url.startsWith("pglite://")) {
    const location = url.slice("pglite://".length);
    if (location !== "memory") mkdirSync(location, { recursive: true });
    const lite = location === "memory" ? new PGlite() : new PGlite(location);
    await lite.waitReady;
    const pool = new PGlitePool(lite);
    const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: pool as unknown as pg.Pool }) });
    return {
      db,
      exec: async (sql) => {
        await pool.withLock(() => lite.exec(sql));
      },
      close: async () => {
        await db.destroy();
        await lite.close();
      },
    };
  }
  const pgPool = new pg.Pool({ connectionString: url, max: 20 });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: pgPool }) });
  return {
    db,
    exec: async (sql) => {
      await pgPool.query(sql);
    },
    close: () => db.destroy(),
  };
}

/**
 * The subset of `pg.Pool` Kysely uses, over one PGlite instance. PGlite is a
 * single connection, so "connections" are handed out one at a time; that
 * keeps transactions isolated from each other.
 */
class PGlitePool {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly lite: PGlite) {}

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      return await fn();
    } finally {
      client.release();
    }
  }

  connect(): Promise<{ query: PGliteClient["query"]; release: () => void }> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => (release = resolve));
    const previous = this.queue;
    this.queue = previous.then(() => turn);
    return previous.then(() => {
      const client = new PGliteClient(this.lite);
      return { query: client.query.bind(client), release };
    });
  }

  async end(): Promise<void> {}
}

class PGliteClient {
  constructor(private readonly lite: PGlite) {}

  async query(sql: string, params: unknown[] = []) {
    const result = await this.lite.query<Record<string, unknown>>(sql, params);
    const command = sql.trimStart().split(/\s+/, 1)[0]?.toUpperCase() ?? "";
    return { command, rowCount: result.affectedRows ?? result.rows.length, rows: result.rows };
  }
}
