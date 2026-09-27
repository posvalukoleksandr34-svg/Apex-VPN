import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from "fastify";
import { z } from "zod";
import { badRequest } from "./errors.js";
import { requireAdmin, requireNode, requireUser, type NodeAuth, type UserAuth } from "./auth.js";

/**
 * Route definitions double as the API contract: each route's Zod schemas
 * validate requests at runtime and are collected into the OpenAPI document
 * (`npm run openapi`).
 */
export interface RouteSpec<B extends z.ZodType, Q extends z.ZodType, P extends z.ZodType, R extends z.ZodType> {
  method: HTTPMethods;
  url: string;
  tag: string;
  summary: string;
  auth: "user" | "admin" | "node" | "none";
  body?: B;
  query?: Q;
  params?: P;
  response?: R;
  status?: number;
  /** Requests per minute per client IP (defaults to the global limit). */
  rateLimit?: number;
}

export const registry: RouteSpec<z.ZodType, z.ZodType, z.ZodType, z.ZodType>[] = [];

interface Ctx<B, Q, P, A> {
  req: FastifyRequest;
  reply: FastifyReply;
  body: B;
  query: Q;
  params: P;
  auth: A;
}

type AuthOf<S> = S extends { auth: "user" | "admin" } ? UserAuth : S extends { auth: "node" } ? NodeAuth : null;

export function route<
  B extends z.ZodType = z.ZodUndefined,
  Q extends z.ZodType = z.ZodUndefined,
  P extends z.ZodType = z.ZodUndefined,
  R extends z.ZodType = z.ZodType,
  S extends RouteSpec<B, Q, P, R> = RouteSpec<B, Q, P, R>,
>(
  app: FastifyInstance,
  spec: S & RouteSpec<B, Q, P, R>,
  handler: (ctx: Ctx<z.infer<B>, z.infer<Q>, z.infer<P>, AuthOf<S>>) => Promise<z.input<R> | void>,
): void {
  registry.push(spec as unknown as RouteSpec<z.ZodType, z.ZodType, z.ZodType, z.ZodType>);
  app.route({
    method: spec.method,
    url: spec.url,
    config: spec.rateLimit ? { rateLimit: { max: spec.rateLimit, timeWindow: "1 minute" } } : {},
    handler: async (req, reply) => {
      const auth =
        spec.auth === "user"
          ? await requireUser(req)
          : spec.auth === "admin"
            ? await requireAdmin(req)
            : spec.auth === "node"
              ? await requireNode(req)
              : null;
      const body = parse(spec.body, req.body, "body");
      const query = parse(spec.query, req.query, "query");
      const params = parse(spec.params, req.params, "params");
      const result = await handler({ req, reply, body, query, params, auth: auth as AuthOf<S> });
      if (reply.sent) return reply;
      reply.status(spec.status ?? (result === undefined ? 204 : 200));
      return result === undefined ? reply.send() : result;
    },
  });
}

function parse<T extends z.ZodType>(schema: T | undefined, value: unknown, where: string): z.infer<T> {
  if (!schema) return undefined as z.infer<T>;
  const r = schema.safeParse(value ?? (where === "body" ? {} : value));
  if (!r.success) {
    throw badRequest(
      "invalid_request",
      `invalid ${where}`,
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}
