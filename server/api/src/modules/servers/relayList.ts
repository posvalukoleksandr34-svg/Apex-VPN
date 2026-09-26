import { sql } from "kysely";
import type { AppDeps } from "../../deps.js";
import { signDetached } from "../../security/keys.js";

/**
 * Builds, signs and caches the relay list the service verifies.
 *
 * Status and health are derived from measurements, never typed in:
 * * `maintenance` is set by operators;
 * * `online` / `busy` need a node heartbeat (or a monitor probe) from the
 *   last 3 minutes; `busy` at 85 % of capacity;
 * * everything else is `offline`;
 * * `load` is only published while the node heartbeat is fresh.
 */
const FRESH_MS = 3 * 60_000;
const REBUILD_AFTER_MS = 60_000;

export interface SignedRelayList {
  payload: string;
  signature: string;
  keyId: string;
}

interface Cached {
  list: SignedRelayList;
  builtAt: number;
  expiresAt: number;
}

/** Per app instance (tests run several side by side). */
const caches = new WeakMap<AppDeps, Cached>();

/** Call after fleet changes so clients see them within one request. */
export function invalidateRelayCache(deps: AppDeps): void {
  caches.delete(deps);
}

export async function currentRelayList(deps: AppDeps): Promise<SignedRelayList> {
  const now = deps.now().getTime();
  const cached = caches.get(deps);
  if (cached && now - cached.builtAt < REBUILD_AFTER_MS && cached.expiresAt > now) return cached.list;
  const built = await buildRelayList(deps);
  caches.set(deps, { list: built.signed, builtAt: now, expiresAt: built.expiresAt });
  return built.signed;
}

export async function buildRelayList(deps: AppDeps): Promise<{ signed: SignedRelayList; version: number; expiresAt: number }> {
  const { db } = deps.database;
  const now = deps.now();
  const freshSince = new Date(now.getTime() - FRESH_MS);

  const locations = await db.selectFrom("fleet.locations").selectAll().orderBy("id").execute();
  const servers = await db.selectFrom("fleet.servers").selectAll().orderBy("id").execute();
  const samples = await db
    .selectFrom("fleet.health_samples")
    .selectAll()
    .where("measured_at", ">=", freshSince)
    .orderBy("measured_at", "desc")
    .execute();
  const latest = (serverId: string, source: "node" | "monitor") =>
    samples.find((s) => s.server_id === serverId && s.source === source);

  const serverEntries = servers.map((s) => {
    const node = latest(s.id, "node");
    const monitor = latest(s.id, "monitor");
    const load = node?.active_peers != null ? Math.min(100, Math.round((node.active_peers / Math.max(1, s.capacity)) * 100)) : null;
    let status: string;
    if (s.status === "maintenance") status = "maintenance";
    else if (node && node.wg_healthy !== false) status = load !== null && load >= 85 ? "busy" : "online";
    else if (monitor?.reachable) status = "online";
    else status = "offline";
    const measured = node ?? monitor;
    return {
      id: s.id,
      hostname: s.hostname,
      locationId: s.location_id,
      status,
      load,
      capacity: s.capacity,
      features: s.features,
      ipv4: stripMask(s.ipv4),
      ipv6: s.ipv6 ? stripMask(s.ipv6) : null,
      wireguard:
        s.wg_public_key && s.wg_gateway_ipv4
          ? {
              publicKey: s.wg_public_key,
              ports: s.wg_ports,
              gatewayIpv4: stripMask(s.wg_gateway_ipv4),
              gatewayIpv6: s.wg_gateway_ipv6 ? stripMask(s.wg_gateway_ipv6) : null,
              dnsIpv4: s.wg_dns_ipv4 ? stripMask(s.wg_dns_ipv4) : null,
            }
          : null,
      openvpn: null,
      ikev2: null,
      health: measured
        ? {
            measuredAt: new Date(measured.measured_at).getTime(),
            packetLoss: measured.packet_loss,
            wireguardHealthy: node?.wg_healthy ?? null,
            openvpnHealthy: null,
            ikev2Healthy: null,
          }
        : null,
    };
  });

  const { rows } = await sql<{ v: string }>`SELECT nextval(pg_get_serial_sequence('fleet.relay_lists', 'version')) AS v`.execute(db);
  const version = Number(rows[0]!.v);
  const expiresAt = now.getTime() + deps.config.RELAY_LIST_TTL_MINUTES * 60_000;
  const body = {
    version,
    generatedAt: now.getTime(),
    expiresAt,
    locations: locations.map((l) => ({
      id: l.id,
      countryCode: l.country_code,
      country: l.country,
      city: l.city,
      latitude: l.latitude,
      longitude: l.longitude,
    })),
    servers: serverEntries,
  };
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  const signed: SignedRelayList = {
    payload: bytes.toString("base64"),
    signature: signDetached(deps.keys.relay, bytes).toString("base64"),
    keyId: deps.config.RELAY_KEY_ID,
  };
  await db
    .insertInto("fleet.relay_lists")
    .values({ version: String(version) as never, expires_at: new Date(expiresAt), payload: signed.payload, signature: signed.signature, key_id: signed.keyId })
    .execute();
  return { signed, version, expiresAt };
}

/** `inet` values can come back as `1.2.3.4/32`. */
function stripMask(v: string): string {
  return v.replace(/\/(32|128)$/, "");
}
