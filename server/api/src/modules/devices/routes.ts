import type { FastifyInstance } from "fastify";
import type { Selectable } from "kysely";
import { z } from "zod";
import type { DevicesTable } from "../../db/schema.js";
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from "../../lib/errors.js";
import { route } from "../../lib/route.js";
import { entitlement } from "../subscription/entitlement.js";

/** Base64 of a 32-byte Curve25519 public key. */
export const WgPublicKey = z
  .string()
  .trim()
  .refine((v) => /^[A-Za-z0-9+/]{43}=$/.test(v) && Buffer.from(v, "base64").length === 32, "not a WireGuard public key");

const DeviceDto = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  appVersion: z.string().nullable(),
  publicKey: z.string(),
  ipv4Address: z.string(),
  ipv6Address: z.string().nullable(),
  createdAt: z.string(),
  lastSeenOn: z.string(),
  connected: z.boolean(),
  connectedServerId: z.string().nullable(),
});

/** Same shape as `vpn_types::DeviceRegistration` (what the service stores). */
const Registration = z.object({
  deviceId: z.string(),
  publicKey: z.string(),
  ipv4Address: z.string(),
  ipv6Address: z.string().nullable(),
  validUntil: z.number().nullable(),
});

const strip = (v: string | null) => (v ? v.replace(/\/(32|128)$/, "") : null);

export function deviceRoutes(app: FastifyInstance): void {
  const deps = () => app.deps;

  const dto = (d: Selectable<DevicesTable>) => {
    const live = deps().activePeers.lookup(d.wg_public_key);
    return {
      id: d.id,
      name: d.name,
      platform: d.platform,
      appVersion: d.app_version,
      publicKey: d.wg_public_key,
      ipv4Address: strip(d.ipv4)!,
      ipv6Address: strip(d.ipv6),
      createdAt: new Date(d.created_at).toISOString(),
      lastSeenOn: String(d.last_seen_on).slice(0, 10),
      connected: live !== null,
      connectedServerId: live?.serverId ?? null,
    };
  };

  const registration = (d: Selectable<DevicesTable>, validUntil: Date | null) => ({
    deviceId: d.id,
    publicKey: d.wg_public_key,
    ipv4Address: strip(d.ipv4)!,
    ipv6Address: strip(d.ipv6),
    validUntil: validUntil?.getTime() ?? null,
  });

  async function owned(userId: string, id: string) {
    const d = await deps()
      .database.db.selectFrom("ops.devices")
      .selectAll()
      .where("id", "=", id)
      .where("user_id", "=", userId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (!d) throw notFound("device_not_found");
    return d;
  }

  async function requireEntitled(userId: string) {
    const d = deps();
    const user = await d.database.db.selectFrom("identity.users").select(["email_verified_at"]).where("id", "=", userId).executeTakeFirstOrThrow();
    if (!user.email_verified_at) throw forbidden("email_unverified", "verify your email before adding devices");
    const ent = await entitlement(d.database.db, userId, d.now());
    if (!ent) throw forbidden("subscription_inactive");
    return ent;
  }

  route(app, { method: "GET", url: "/v1/devices", tag: "devices", summary: "Devices on the account.", auth: "user", response: z.array(DeviceDto) },
    async ({ auth }) => {
      const rows = await deps()
        .database.db.selectFrom("ops.devices")
        .selectAll()
        .where("user_id", "=", auth.userId)
        .where("revoked_at", "is", null)
        .orderBy("created_at")
        .execute();
      return rows.map(dto);
    });

  route(
    app,
    {
      method: "POST",
      url: "/v1/devices",
      tag: "devices",
      summary: "Register this device's WireGuard key. Idempotent per key. Assigns its tunnel addresses.",
      auth: "user",
      rateLimit: 20,
      body: z.object({
        name: z.string().trim().min(1).max(64),
        platform: z.enum(["windows", "macos", "linux", "other"]),
        appVersion: z.string().max(32).optional(),
        publicKey: WgPublicKey,
      }),
      response: z.object({ device: DeviceDto, registration: Registration }),
      status: 201,
    },
    async ({ auth, body }) => {
      const d = deps();
      const ent = await requireEntitled(auth.userId);
      const { db } = d.database;
      const existing = await db.selectFrom("ops.devices").selectAll().where("wg_public_key", "=", body.publicKey).where("revoked_at", "is", null).executeTakeFirst();
      if (existing) {
        if (existing.user_id !== auth.userId) throw conflict("key_in_use", "this key belongs to another account");
        let device = existing;
        if (d.provisioner.refresh) {
          try {
            device = await d.provisioner.refresh(db, existing);
          } catch (e) {
            throw badRequest("provisioning_failed", (e as Error).message);
          }
        }
        d.peerSet.changed(); // a refresh may have moved the tunnel address
        return { device: dto(device), registration: registration(device, ent.validUntil) };
      }
      const active = await db
        .selectFrom("ops.devices")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("user_id", "=", auth.userId)
        .where("revoked_at", "is", null)
        .executeTakeFirstOrThrow();
      if (Number(active.n) >= ent.deviceLimit) throw forbidden("device_limit_reached", `your plan allows ${ent.deviceLimit} devices`);
      let addr: { ipv4: string; ipv6: string | null };
      try {
        addr = await d.provisioner.allocate(db, body.publicKey);
      } catch (e) {
        throw badRequest("provisioning_failed", (e as Error).message);
      }
      let device: Selectable<DevicesTable>;
      try {
        device = await db
          .insertInto("ops.devices")
          .values({
            user_id: auth.userId,
            name: body.name,
            platform: body.platform,
            app_version: body.appVersion ?? null,
            wg_public_key: body.publicKey,
            ipv4: addr.ipv4,
            ipv6: addr.ipv6,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        // Two enrollments of the same key raced: the other one won, so this
        // is the idempotent case after all.
        const winner = await db.selectFrom("ops.devices").selectAll().where("wg_public_key", "=", body.publicKey).where("revoked_at", "is", null).executeTakeFirst();
        if (!winner) throw conflict("address_in_use", "the assigned tunnel address is taken; try again");
        if (winner.user_id !== auth.userId) throw conflict("key_in_use", "this key belongs to another account");
        device = winner;
      }
      d.peerSet.changed(); // nodes accept the new key now
      return { device: dto(device), registration: registration(device, ent.validUntil) };
    },
  );

  route(
    app,
    {
      method: "PUT",
      url: "/v1/devices/:id/key",
      tag: "devices",
      summary: "Replace a device's WireGuard key (key rotation). Keeps its addresses.",
      auth: "user",
      params: z.object({ id: z.uuid() }),
      body: z.object({ publicKey: WgPublicKey }),
      response: Registration,
    },
    async ({ auth, params, body }) => {
      const d = deps();
      const ent = await requireEntitled(auth.userId);
      const device = await owned(auth.userId, params.id);
      const clash = await d.database.db.selectFrom("ops.devices").select("id").where("wg_public_key", "=", body.publicKey).where("revoked_at", "is", null).where("id", "!=", device.id).executeTakeFirst();
      if (clash) throw conflict("key_in_use");
      if (d.provisioner.name === "wireguard-demo") {
        const addr = await d.provisioner.allocate(d.database.db, body.publicKey);
        await d.database.db.updateTable("ops.devices").set({ ipv4: addr.ipv4 }).where("id", "=", device.id).execute();
      }
      const updated = await d.database.db
        .updateTable("ops.devices")
        .set({ wg_public_key: body.publicKey, last_seen_on: d.now().toISOString().slice(0, 10) })
        .where("id", "=", device.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      d.peerSet.changed(); // the old key stops working on every node now
      return registration(updated, ent.validUntil);
    },
  );

  route(
    app,
    {
      method: "PATCH",
      url: "/v1/devices/:id",
      tag: "devices",
      summary: "Rename a device.",
      auth: "user",
      params: z.object({ id: z.uuid() }),
      body: z.object({ name: z.string().trim().min(1).max(64) }),
      response: DeviceDto,
    },
    async ({ auth, params, body }) => {
      await owned(auth.userId, params.id);
      const updated = await deps().database.db.updateTable("ops.devices").set({ name: body.name }).where("id", "=", params.id).returningAll().executeTakeFirstOrThrow();
      return dto(updated);
    },
  );

  route(
    app,
    {
      method: "GET",
      url: "/v1/connections",
      tag: "devices",
      summary: "Which of the account's devices have a live tunnel right now (from node heartbeats; no history is kept).",
      auth: "user",
      response: z.array(z.object({ deviceId: z.string(), deviceName: z.string(), serverId: z.string() })),
    },
    async ({ auth }) => {
      const rows = await deps()
        .database.db.selectFrom("ops.devices")
        .select(["id", "name", "wg_public_key"])
        .where("user_id", "=", auth.userId)
        .where("revoked_at", "is", null)
        .execute();
      return rows.flatMap((r) => {
        const live = deps().activePeers.lookup(r.wg_public_key);
        return live ? [{ deviceId: r.id, deviceName: r.name, serverId: live.serverId }] : [];
      });
    },
  );

  route(
    app,
    {
      method: "DELETE",
      url: "/v1/devices/:id",
      tag: "devices",
      summary: "Revoke a device. Nodes drop its key within seconds, ending any tunnel it has.",
      auth: "user",
      params: z.object({ id: z.uuid() }),
    },
    async ({ auth, params }) => {
      await owned(auth.userId, params.id);
      await deps().database.db.updateTable("ops.devices").set({ revoked_at: deps().now() }).where("id", "=", params.id).execute();
      deps().peerSet.changed();
    },
  );
}
