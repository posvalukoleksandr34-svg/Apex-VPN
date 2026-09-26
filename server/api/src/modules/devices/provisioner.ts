import { connect } from "node:net";
import { sql, type Kysely, type Selectable } from "kysely";
import type { DB, DevicesTable } from "../../db/schema.js";

/**
 * Assigns tunnel addresses to a device key and makes the key known to the
 * nodes.
 *
 * * `AgentProvisioner` (production): sequential addresses from
 *   10.64.0.0/10 and fc00:bbbb:bbbb:bb01::/64; nodes pull the peer set from
 *   `/v1/nodes/self/peers`.
 * * `WireGuardDemoProvisioner` (development only): registers the key with
 *   the public test server at demo.wireguard.com, which assigns the address.
 *   That makes a real internet tunnel possible without running a node.
 */
export interface PeerProvisioner {
  readonly name: string;
  allocate(db: Kysely<DB>, publicKey: string): Promise<{ ipv4: string; ipv6: string | null }>;
  /**
   * Called when an already-enrolled key enrolls again (every app start).
   * Nodes that keep their own peer state can forget peers; this is where
   * the provisioner makes sure the key still works. Returns the device,
   * updated if its address changed.
   */
  refresh?(db: Kysely<DB>, device: Selectable<DevicesTable>): Promise<Selectable<DevicesTable>>;
}

export const POOL_V4_BASE = (10 << 24) | (64 << 16); // 10.64.0.0
export const POOL_V4_SIZE = 1 << 22; // /10

export function v4FromIndex(index: number): string {
  if (index < 2 || index >= POOL_V4_SIZE - 1) throw new Error("address pool exhausted");
  const n = POOL_V4_BASE + index;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export function v6FromIndex(index: number): string {
  const hi = Math.floor(index / 0x10000).toString(16);
  const lo = (index % 0x10000).toString(16);
  return `fc00:bbbb:bbbb:bb01::${hi}:${lo}`;
}

export class AgentProvisioner implements PeerProvisioner {
  readonly name = "agent";

  async allocate(db: Kysely<DB>): Promise<{ ipv4: string; ipv6: string | null }> {
    const { rows } = await sql<{ n: string }>`SELECT nextval('ops.device_address_seq') AS n`.execute(db);
    const index = Number(rows[0]!.n);
    return { ipv4: v4FromIndex(index), ipv6: v6FromIndex(index) };
  }
}

export interface DemoRegistration {
  serverPublicKey: string;
  serverPort: number;
  ipv4: string;
}

/**
 * Talks the demo server's registration protocol: send `<pubkey>\n` to TCP
 * 42912, receive `OK:<server pubkey>:<port>:<assigned ip>\n`.
 */
export function registerWithDemoServer(publicKey: string, host = "demo.wireguard.com"): Promise<DemoRegistration> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: 42912, timeout: 8000 });
    let data = "";
    socket.on("connect", () => socket.write(`${publicKey}\n`));
    socket.on("data", (d) => (data += d.toString("utf8")));
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("demo server timed out"));
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const [status, serverPublicKey, port, ip] = data.trim().split(":");
      if (status !== "OK" || !serverPublicKey || !port || !ip) {
        reject(new Error(`demo server refused: ${data.trim().slice(0, 80)}`));
        return;
      }
      resolve({ serverPublicKey, serverPort: Number(port), ipv4: ip });
    });
  });
}

export class WireGuardDemoProvisioner implements PeerProvisioner {
  readonly name = "wireguard-demo";

  async allocate(db: Kysely<DB>, publicKey: string): Promise<{ ipv4: string; ipv6: string | null }> {
    const reg = await registerWithDemoServer(publicKey);
    // Keep the demo server's fleet entry in step with what it reports.
    await db
      .updateTable("fleet.servers")
      .set({ wg_public_key: reg.serverPublicKey, wg_ports: [reg.serverPort], updated_at: new Date() })
      .where("hostname", "=", "demo.wireguard.com")
      .execute();
    // The demo server owns its address space and reuses addresses of peers
    // it has expired. Whoever held this one before no longer has a working
    // registration, so retire it rather than refuse the new key.
    await db
      .updateTable("ops.devices")
      .set({ revoked_at: new Date() })
      .where("ipv4", "=", reg.ipv4)
      .where("wg_public_key", "<>", publicKey)
      .where("revoked_at", "is", null)
      .execute();
    return { ipv4: reg.ipv4, ipv6: null };
  }

  /** The demo server expires idle peers; registering again restores ours. */
  async refresh(db: Kysely<DB>, device: Selectable<DevicesTable>): Promise<Selectable<DevicesTable>> {
    const { ipv4 } = await this.allocate(db, device.wg_public_key);
    const had = String(device.ipv4).split("/")[0];
    console.info(`[demo provisioner] re-registered ${device.wg_public_key.slice(0, 8)}…: demo server says ${ipv4}, database had ${had}`);
    if (had === ipv4) return device;
    return db.updateTable("ops.devices").set({ ipv4 }).where("id", "=", device.id).returningAll().executeTakeFirstOrThrow();
  }
}
