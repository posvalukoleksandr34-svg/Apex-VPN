import { loadConfig } from "../config.js";
import { openDatabase } from "../db/client.js";
import { migrate } from "../db/migrate.js";

const database = await openDatabase(loadConfig().DATABASE_URL);
const ran = await migrate(database);
console.log(ran.length ? `applied: ${ran.join(", ")}` : "database is up to date");
await database.close();
