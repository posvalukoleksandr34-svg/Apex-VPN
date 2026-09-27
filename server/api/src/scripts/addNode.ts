/**
 * Registers a VPN node, or gives an existing one a new token. The token is
 * written to a file (mode 0600) for the node's /etc/apexy/node-token; only
 * its hash is stored. A new token takes effect at once: the old one stops
 * working, and a node still using it removes its peers.
 *
 *   npm run node:add -- --id de-fra-001 --hostname de-fra-001.apexy.net \
 *     --ipv4 203.0.113.10 [--ipv6 2001:db8::10] [--port 51820] [--capacity 500] \
 *     [--features p2p,streaming] --location de-fra \
 *     [--country-code DE --country Germany --city Frankfurt --lat 50.11 --lon 8.68] \
 *     --token-out de-fra-001.token
 *
 *   npm run node:add -- --id de-fra-001 --rotate-token --token-out de-fra-001.token
 *
 * The node introduces its WireGuard public key with its first heartbeat and
 * appears in the relay list from then on, while its heartbeats are fresh.
 */
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isIP } from "node:net";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { sha256 } from "../security/tokens.js";

const FEATURES = ["streaming", "gaming", "privacy", "p2p", "low_latency"];
/** Every node's tunnel gateway and resolver (deploy/node/wg0.conf). */
const GATEWAY_V4 = "10.64.0.1";
const GATEWAY_V6 = "fc00:bbbb:bbbb:bb01::1";

const { values: a } = parseArgs({
  options: {
    id: { type: "string" },
    hostname: { type: "string" },
    ipv4: { type: "string" },
    ipv6: { type: "string" },
    port: { type: "string", default: "51820" },
    capacity: { type: "string", default: "500" },
    features: { type: "string", default: "" },
    location: { type: "string" },
    "country-code": { type: "string" },
    country: { type: "string" },
    city: { type: "string" },
    lat: { type: "string" },
    lon: { type: "string" },
    "rotate-token": { type: "boolean", default: false },
    "token-out": { type: "string" },
  },
});

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

if (!a.id || !/^[A-Za-z0-9_-]{1,64}$/.test(a.id)) fail("--id: letters, digits, - and _ (e.g. de-fra-001)");
if (!a["token-out"]) fail("--token-out: where to write the node's token");
if (existsSync(a["token-out"])) fail(`${a["token-out"]} exists; choose a new file`);
if (!existsSync(dirname(resolve(a["token-out"])))) fail(`${dirname(resolve(a["token-out"]))} doesn't exist`);

const database = await openDatabase(loadConfig().DATABASE_URL);
await migrate(database);
const { db } = database;
const token = randomBytes(32).toString("base64url");

try {
  if (a["rotate-token"]) {
    const res = await db.updateTable("fleet.servers").set({ node_token_hash: sha256(token), updated_at: new Date() }).where("id", "=", a.id).executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) fail(`no node ${a.id}`);
  } else {
    if (!a.hostname) fail("--hostname is required");
    if (!a.ipv4 || isIP(a.ipv4) !== 4) fail("--ipv4: the node's public IPv4 address");
    if (a.ipv6 && isIP(a.ipv6) !== 6) fail("--ipv6: an IPv6 address");
    const port = Number(a.port);
    const capacity = Number(a.capacity);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--port: a UDP port");
    if (!Number.isInteger(capacity) || capacity < 1) fail("--capacity: concurrent devices the node is sized for");
    const features = a.features ? a.features.split(",").map((f) => f.trim()) : [];
    const unknown = features.filter((f) => !FEATURES.includes(f));
    if (unknown.length) fail(`--features: unknown ${unknown.join(", ")} (known: ${FEATURES.join(", ")})`);
    if (!a.location) fail("--location: a location id (e.g. de-fra)");

    const location = await db.selectFrom("fleet.locations").select("id").where("id", "=", a.location).executeTakeFirst();
    if (!location) {
      const cc = a["country-code"];
      const [lat, lon] = [Number(a.lat), Number(a.lon)];
      if (!cc || !/^[A-Z]{2}$/.test(cc) || !a.country || !a.city || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        fail(`location ${a.location} is new: give --country-code, --country, --city, --lat and --lon`);
      }
      await db.insertInto("fleet.locations").values({ id: a.location, country_code: cc, country: a.country, city: a.city, latitude: lat, longitude: lon }).execute();
    }
    const taken = await db.selectFrom("fleet.servers").select("id").where("id", "=", a.id).executeTakeFirst();
    if (taken) fail(`node ${a.id} exists; use --rotate-token for a new token`);
    await db
      .insertInto("fleet.servers")
      .values({
        id: a.id,
        hostname: a.hostname,
        location_id: a.location,
        ipv4: a.ipv4,
        ipv6: a.ipv6 ?? null,
        status: "online",
        capacity,
        features,
        wg_ports: [port],
        wg_gateway_ipv4: GATEWAY_V4,
        wg_gateway_ipv6: a.ipv6 ? GATEWAY_V6 : null,
        wg_dns_ipv4: GATEWAY_V4,
        node_token_hash: sha256(token),
      })
      .execute();
  }
  writeFileSync(a["token-out"], `${token}\n`, { mode: 0o600, flag: "wx" });
  console.log(`${a["rotate-token"] ? "new token for" : "registered"} ${a.id}; its token is in ${a["token-out"]}`);
} finally {
  await database.close();
}
