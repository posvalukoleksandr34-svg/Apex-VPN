import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../../lib/errors.js";
import { route } from "../../lib/route.js";

/**
 * Optional cloud sync of connection profiles. The desktop app owns the
 * profile format; the server stores it opaquely (size-limited) and never
 * interprets it.
 */
const ProfileDto = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(64),
  kind: z.enum(["gaming", "streaming", "work", "privacy", "travel", "custom"]),
  data: z.record(z.string(), z.unknown()),
  updatedAt: z.string().optional(),
});

export function profileRoutes(app: FastifyInstance): void {
  const db = () => app.deps.database.db;

  route(app, { method: "GET", url: "/v1/profiles", tag: "profiles", summary: "Synced profiles.", auth: "user", response: z.array(ProfileDto) },
    async ({ auth }) => {
      const rows = await db().selectFrom("ops.profiles").selectAll().where("user_id", "=", auth.userId).orderBy("name").execute();
      return rows.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind as z.infer<typeof ProfileDto>["kind"],
        data: (typeof p.data === "string" ? JSON.parse(p.data) : p.data) as Record<string, unknown>,
        updatedAt: new Date(p.updated_at).toISOString(),
      }));
    });

  route(
    app,
    {
      method: "PUT",
      url: "/v1/profiles/:id",
      tag: "profiles",
      summary: "Create or replace a profile.",
      auth: "user",
      params: z.object({ id: z.uuid() }),
      body: ProfileDto.omit({ id: true, updatedAt: true }),
    },
    async ({ auth, params, body }) => {
      const data = JSON.stringify(body.data);
      if (data.length > 16_384) throw badRequest("profile_too_large");
      const count = await db().selectFrom("ops.profiles").select((eb) => eb.fn.countAll<string>().as("n")).where("user_id", "=", auth.userId).executeTakeFirstOrThrow();
      const existing = await db().selectFrom("ops.profiles").select(["user_id"]).where("id", "=", params.id).executeTakeFirst();
      if (existing && existing.user_id !== auth.userId) throw badRequest("invalid_id");
      if (!existing && Number(count.n) >= 50) throw badRequest("too_many_profiles");
      await db()
        .insertInto("ops.profiles")
        .values({ id: params.id, user_id: auth.userId, name: body.name, kind: body.kind, data })
        .onConflict((oc) => oc.column("id").doUpdateSet({ name: body.name, kind: body.kind, data, updated_at: app.deps.now() }))
        .execute();
    },
  );

  route(
    app,
    { method: "DELETE", url: "/v1/profiles/:id", tag: "profiles", summary: "Delete a synced profile.", auth: "user", params: z.object({ id: z.uuid() }) },
    async ({ auth, params }) => {
      await db().deleteFrom("ops.profiles").where("id", "=", params.id).where("user_id", "=", auth.userId).execute();
    },
  );
}
