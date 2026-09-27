import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import type { AppDeps } from "./deps.js";
import { ApiError } from "./lib/errors.js";
import { authRoutes } from "./modules/auth/routes.js";
import { deviceRoutes } from "./modules/devices/routes.js";
import { nodeRoutes } from "./modules/nodes/routes.js";
import { notificationRoutes } from "./modules/notifications/routes.js";
import { profileRoutes } from "./modules/profiles/routes.js";
import { serverRoutes } from "./modules/servers/routes.js";
import { subscriptionRoutes } from "./modules/subscription/routes.js";
import { supportRoutes } from "./modules/support/routes.js";
import { userRoutes } from "./modules/users/routes.js";

/**
 * No-logs: request logs carry the method and path only. Never the client's
 * address or port, headers, or bodies (credentials and tokens included).
 */
const requestLogFields = {
  req: (req: { method?: string; url?: string }) => ({ method: req.method, url: req.url }),
};

export async function buildApp(deps: AppDeps, options: { logger?: boolean | { stream: NodeJS.WritableStream } } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger
      ? {
          level: "info",
          serializers: requestLogFields,
          ...(typeof options.logger === "object" ? { stream: options.logger.stream } : {}),
        }
      : false,
    trustProxy: deps.config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  });
  app.decorate("deps", deps);

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } });
  if (deps.config.RATE_LIMIT_ENABLED) await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: { code: "rate_limited", message: `too many requests; retry in ${Math.ceil(ctx.ttl / 1000)}s` },
    }),
  });
  await app.register(multipart);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      if (err.headers) reply.headers(err.headers);
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as { statusCode?: number; code?: string; message: string; error?: { code: string; message: string } };
    if (e.statusCode === 429) {
      return reply.status(429).send({ error: e.error ?? { code: "rate_limited", message: e.message } });
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: (e.code ?? "bad_request").toLowerCase(), message: e.message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: "internal", message: "internal error" } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: "not_found", message: "no such route" } }));

  serverRoutes(app);
  authRoutes(app);
  userRoutes(app);
  deviceRoutes(app);
  nodeRoutes(app);
  subscriptionRoutes(app);
  notificationRoutes(app);
  profileRoutes(app);
  supportRoutes(app);
  return app;
}
