import type { FastifyRequest } from "fastify";
import { sql } from "kysely";
import { verifyAccessToken, sha256 } from "../security/tokens.js";
import { unauthorized } from "./errors.js";

export interface UserAuth {
  userId: string;
  /** Session family id (what the user sees as one "session"). */
  sessionId: string;
  amr: string[];
}

export interface NodeAuth {
  serverId: string;
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  return h.slice(7).trim() || null;
}

/** Verifies the access token and that its session hasn't been revoked. */
export async function requireUser(req: FastifyRequest): Promise<UserAuth> {
  const token = bearer(req);
  if (!token) throw unauthorized("missing_token");
  const { deps } = req.server;
  const claims = await verifyAccessToken(deps.keys.access, token);
  if (!claims) throw unauthorized("invalid_token");
  const live = await deps.database.db
    .selectFrom("identity.sessions as s")
    .innerJoin("identity.users as u", "u.id", "s.user_id")
    .select(["s.id"])
    .where("s.family_id", "=", claims.sid)
    .where("s.user_id", "=", claims.sub)
    .where("s.revoked_at", "is", null)
    .where("s.expires_at", ">", sql<Date>`now()`)
    .where("u.is_banned", "=", false)
    .executeTakeFirst();
  if (!live) throw unauthorized("session_revoked");
  return { userId: claims.sub, sessionId: claims.sid, amr: claims.amr };
}

/** VPN nodes authenticate with a per-node token (stored hashed). */
export async function requireNode(req: FastifyRequest): Promise<NodeAuth> {
  const token = bearer(req);
  if (!token) throw unauthorized("missing_token");
  const server = await req.server.deps.database.db
    .selectFrom("fleet.servers")
    .select("id")
    .where("node_token_hash", "=", sha256(token))
    .executeTakeFirst();
  if (!server) throw unauthorized("invalid_node_token");
  return { serverId: server.id };
}
