/**
 * Seeds the development fleet. By default that's the public WireGuard demo
 * server (demo.wireguard.com), which gives a real tunnel over the internet
 * without running a node. Pass `--local-node <ip>` to add a local
 * WireGuard node (docker/wireguard-node) as well.
 *
 * Accounts are never seeded: register through the app or `meridian login`.
 */
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { registerWithDemoServer } from "../modules/devices/provisioner.js";
import { sha256 } from "../security/tokens.js";

const config = loadConfig();
if (config.NODE_ENV === "production") throw new Error("seedDev is for development only");

const database = await openDatabase(config.DATABASE_URL);
await migrate(database);
const { db } = database;

// Learn the demo server's key and port by registering a throwaway key.
const probe = await registerWithDemoServer(randomBytes(32).toString("base64"));
const { address } = await lookup("demo.wireguard.com", { family: 4 });

await db
  .insertInto("fleet.locations")
  .values({ id: "us-demo", country_code: "US", country: "United States", city: "WireGuard demo server", latitude: 42.89, longitude: -78.88 })
  .onConflict((oc) => oc.column("id").doNothing())
  .execute();
await db
  .insertInto("fleet.servers")
  .values({
    id: "us-demo-001",
    hostname: "demo.wireguard.com",
    location_id: "us-demo",
    ipv4: address,
    status: "online",
    capacity: 1000,
    features: [],
    wg_public_key: probe.serverPublicKey,
    wg_ports: [probe.serverPort],
    wg_gateway_ipv4: "192.168.4.1",
    // The demo server routes but runs no resolver at its gateway: name a
    // public one, reached through the tunnel like all other traffic.
    wg_dns_ipv4: "1.1.1.1",
    // The registration port answers TCP, which the fleet monitor probes.
    monitor_tcp_port: 42912,
  })
  .onConflict((oc) =>
    oc.column("id").doUpdateSet({ ipv4: address, wg_public_key: probe.serverPublicKey, wg_ports: [probe.serverPort], wg_dns_ipv4: "1.1.1.1", updated_at: new Date() }),
  )
  .execute();
console.log(`demo server: ${address}:${probe.serverPort}`);

const localIdx = process.argv.indexOf("--local-node");
if (localIdx > 0) {
  const ip = process.argv[localIdx + 1];
  if (!ip) throw new Error("--local-node needs an IP");
  const token = randomBytes(24).toString("base64url");
  await db
    .insertInto("fleet.locations")
    .values({ id: "xx-local", country_code: "DE", country: "Local", city: "Docker node", latitude: 50.11, longitude: 8.68 })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("fleet.servers")
    .values({
      id: "local-001",
      hostname: "local-001.dev",
      location_id: "xx-local",
      ipv4: ip,
      status: "online",
      capacity: 50,
      features: ["p2p"],
      wg_ports: [51820],
      wg_gateway_ipv4: "10.64.0.1",
      node_token_hash: sha256(token),
      monitor_tcp_port: 8080,
    })
    .onConflict((oc) => oc.column("id").doUpdateSet({ ipv4: ip, node_token_hash: sha256(token), updated_at: new Date() }))
    .execute();
  console.log(`local node at ${ip}; start it with NODE_TOKEN=${token}`);
}

await database.close();
