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
      summary:
        "Peers this node must accept: keys and tunnel addresses of devices whose owner has access and isn't banned. With `since` (the version the node has) and `wait` (seconds, up to 30), answers as soon as the set changes, or with the same set when `wait` runs out.",
      auth: "node",
      query: z.object({
        since: z.string().regex(/^[0-9a-f]{24}$/).optional(),
        wait: z.coerce.number().int().min(0).max(30).default(0),
      }),
      response: z.object({
        version: z.string(),
        peers: z.array(z.object({ publicKey: z.string(), allowedIps: z.array(z.string()) })),
      }),
    },
    async ({ query }) => app.deps.peerSet.next(app.deps, query.since, query.wait * 1000),
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
