import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { route } from "../../lib/route.js";
import { WgPublicKey } from "../devices/routes.js";
import { invalidateRelayCache } from "../servers/relayList.js";

/**
 * The API VPN nodes use (node-agent). Nodes pull the peer set and push a
 * heartbeat; they never receive account data, only public keys and tunnel
 * addresses of entitled devices.
 */
export function nodeRoutes(app: FastifyInstance): void {
  route(
    app,
    {
      method: "GET",
      url: "/v1/nodes/self/peers",
      tag: "nodes",
      summary: "Peers this node must accept: keys and tunnel addresses of devices with an active entitlement.",
      auth: "node",
      response: z.object({ peers: z.array(z.object({ publicKey: z.string(), allowedIps: z.array(z.string()) })) }),
    },
    async () => {
      const now = app.deps.now();
      const rows = await app.deps.database.db
        .selectFrom("ops.devices as d")
        .innerJoin("billing.subscriptions as s", "s.user_id", "d.user_id")
        .innerJoin("identity.users as u", "u.id", "d.user_id")
        .select(["d.wg_public_key", "d.ipv4", "d.ipv6"])
        .where("d.revoked_at", "is", null)
        .where("u.status", "=", "active")
        .where("s.status", "in", ["trialing", "active", "past_due"])
        .where("s.current_period_end", ">", now)
        .execute();
      return {
        peers: rows.map((r) => ({
          publicKey: r.wg_public_key,
          allowedIps: [withMask(r.ipv4, 32), ...(r.ipv6 ? [withMask(r.ipv6, 128)] : [])],
        })),
      };
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/nodes/self/heartbeat",
      tag: "nodes",
      summary: "Node health: WireGuard status and the keys with a recent handshake (kept in memory for 3 minutes, never stored).",
      auth: "node",
      body: z.object({
        wgHealthy: z.boolean(),
        activeKeys: z.array(WgPublicKey).max(100_000),
        packetLoss: z.number().min(0).max(100).optional(),
        publicKey: WgPublicKey.optional(),
      }),
    },
    async ({ auth, body }) => {
      const { db } = app.deps.database;
      await db
        .insertInto("fleet.health_samples")
        .values({
          server_id: auth.serverId,
          source: "node",
          reachable: true,
          active_peers: body.activeKeys.length,
          wg_healthy: body.wgHealthy,
          packet_loss: body.packetLoss ?? null,
        })
        .execute();
      if (body.publicKey) {
        // A node may introduce its key once; changing it is an operator action.
        const changed = await db
          .updateTable("fleet.servers")
          .set({ wg_public_key: body.publicKey, updated_at: app.deps.now() })
          .where("id", "=", auth.serverId)
          .where("wg_public_key", "is", null)
          .executeTakeFirst();
        if (Number(changed.numUpdatedRows) > 0) invalidateRelayCache(app.deps);
      }
      app.deps.activePeers.report(auth.serverId, body.activeKeys);
    },
  );
}

function withMask(ip: string, bits: number): string {
  return ip.includes("/") ? ip : `${ip}/${bits}`;
}
