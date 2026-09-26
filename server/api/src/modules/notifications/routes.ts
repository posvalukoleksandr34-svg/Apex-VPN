import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { route } from "../../lib/route.js";

const Prefs = z.object({
  connected: z.boolean().default(true),
  disconnected: z.boolean().default(true),
  connectionFailed: z.boolean().default(true),
  killSwitch: z.boolean().default(true),
  newLogin: z.boolean().default(true),
  subscription: z.boolean().default(true),
  security: z.boolean().default(true),
  updates: z.boolean().default(true),
});

export function notificationRoutes(app: FastifyInstance): void {
  const db = () => app.deps.database.db;

  route(
    app,
    {
      method: "GET",
      url: "/v1/notifications",
      tag: "notifications",
      summary: "Recent notifications (newest first).",
      auth: "user",
      query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
      response: z.array(
        z.object({
          id: z.string(),
          type: z.string(),
          title: z.string(),
          body: z.string(),
          data: z.record(z.string(), z.unknown()),
          createdAt: z.string(),
          readAt: z.string().nullable(),
        }),
      ),
    },
    async ({ auth, query }) => {
      const rows = await db().selectFrom("notify.notifications").selectAll().where("user_id", "=", auth.userId).orderBy("created_at", "desc").limit(query.limit).execute();
      return rows.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        data: (typeof n.data === "string" ? JSON.parse(n.data) : n.data) as Record<string, unknown>,
        createdAt: new Date(n.created_at).toISOString(),
        readAt: n.read_at ? new Date(n.read_at).toISOString() : null,
      }));
    },
  );

  route(
    app,
    { method: "POST", url: "/v1/notifications/:id/read", tag: "notifications", summary: "Mark one read.", auth: "user", params: z.object({ id: z.uuid() }) },
    async ({ auth, params }) => {
      await db().updateTable("notify.notifications").set({ read_at: app.deps.now() }).where("id", "=", params.id).where("user_id", "=", auth.userId).execute();
    },
  );

  route(
    app,
    { method: "POST", url: "/v1/notifications/read-all", tag: "notifications", summary: "Mark all read.", auth: "user" },
    async ({ auth }) => {
      await db().updateTable("notify.notifications").set({ read_at: app.deps.now() }).where("user_id", "=", auth.userId).where("read_at", "is", null).execute();
    },
  );

  route(app, { method: "GET", url: "/v1/notifications/preferences", tag: "notifications", summary: "Which events notify.", auth: "user", response: Prefs },
    async ({ auth }) => {
      const row = await db().selectFrom("notify.preferences").select("prefs").where("user_id", "=", auth.userId).executeTakeFirst();
      const stored = row ? (typeof row.prefs === "string" ? JSON.parse(row.prefs) : row.prefs) : {};
      return Prefs.parse(stored);
    });

  route(
    app,
    { method: "PUT", url: "/v1/notifications/preferences", tag: "notifications", summary: "Update notification preferences.", auth: "user", body: Prefs, response: Prefs },
    async ({ auth, body }) => {
      await db()
        .insertInto("notify.preferences")
        .values({ user_id: auth.userId, prefs: JSON.stringify(body) })
        .onConflict((oc) => oc.column("user_id").doUpdateSet({ prefs: JSON.stringify(body) }))
        .execute();
      return body;
    },
  );
}
