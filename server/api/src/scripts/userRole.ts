/**
 * Makes an account staff (admin) or takes it back. Run by an operator with
 * database access; no endpoint can grant a role, so no web request can
 * escalate privileges.
 *
 *   npm run user:role -w server/api -- --email you@example.com --role admin
 *   npm run user:role -w server/api -- --email you@example.com --role user
 *
 * In production admins also need two-step verification (ADMIN_REQUIRE_MFA);
 * turn it on in the desktop app (Account → Security) first.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/client.js";
import { migrate } from "../db/migrate.js";

const { values: a } = parseArgs({ options: { email: { type: "string" }, role: { type: "string" } } });
if (!a.email || (a.role !== "admin" && a.role !== "user")) {
  console.error("usage: npm run user:role -w server/api -- --email <email> --role admin|user");
  process.exit(2);
}

const database = await openDatabase(loadConfig().DATABASE_URL);
try {
  await migrate(database);
  const res = await database.db
    .updateTable("identity.users")
    .set({ role: a.role, updated_at: new Date() })
    .where((eb) => eb(eb.fn("lower", ["email"]), "=", a.email!.trim().toLowerCase()))
    .returning(["email", "role", "totp_enabled_at"])
    .executeTakeFirst();
  if (!res) {
    console.error(`no account ${a.email}`);
    process.exitCode = 1;
  } else {
    console.log(`${res.email} is now ${res.role}${res.role === "admin" && !res.totp_enabled_at ? " (two-step verification is off: production refuses staff tools until it's on)" : ""}`);
  }
} finally {
  await database.close();
}
