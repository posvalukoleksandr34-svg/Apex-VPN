import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { route } from "../../lib/route.js";
import { currentRelayList } from "./relayList.js";

export function serverRoutes(app: FastifyInstance): void {
  route(
    app,
    {
      method: "GET",
      url: "/v1/health",
      tag: "meta",
      summary: "Liveness.",
      auth: "none",
      response: z.object({ status: z.literal("ok"), time: z.number() }),
    },
    async () => ({ status: "ok" as const, time: app.deps.now().getTime() }),
  );

  route(
    app,
    {
      method: "GET",
      url: "/v1/servers/relays",
      tag: "servers",
      summary: "The signed server list. `payload` is base64 of the exact bytes signed with the fleet key (Ed25519).",
      auth: "none",
      response: z.object({ payload: z.string(), signature: z.string(), keyId: z.string() }),
    },
    async ({ reply }) => {
      reply.header("cache-control", "public, max-age=60");
      return currentRelayList(app.deps);
    },
  );

  route(
    app,
    {
      method: "GET",
      url: "/v1/network/ip",
      tag: "network",
      summary: "The caller's public address as seen by the API, with GeoIP details when a database is configured (else null).",
      auth: "none",
      rateLimit: 60,
      response: z.object({
        ip: z.string(),
        countryCode: z.string().nullable(),
        country: z.string().nullable(),
        city: z.string().nullable(),
        timezone: z.string().nullable(),
        asn: z.number().nullable(),
        organization: z.string().nullable(),
        latitude: z.number().nullable(),
        longitude: z.number().nullable(),
      }),
    },
    async ({ req, reply }) => {
      reply.header("cache-control", "no-store");
      const ip = req.ip.replace(/^::ffff:/, "");
      return { ip, ...app.deps.geoip.lookup(ip) };
    },
  );
}
