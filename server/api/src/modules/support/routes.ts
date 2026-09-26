import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest, notFound, notImplemented } from "../../lib/errors.js";
import { requireUser } from "../../lib/auth.js";
import { route } from "../../lib/route.js";

const Category = z.enum(["connection", "billing", "account", "privacy", "other"]);
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "text/plain", "application/json", "application/zip", "application/pdf"]);
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const TicketDto = z.object({
  id: z.string(),
  number: z.number(),
  subject: z.string(),
  category: Category,
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export function supportRoutes(app: FastifyInstance): void {
  const db = () => app.deps.database.db;
  const ticketDto = (t: { id: string; number: number; subject: string; category: z.infer<typeof Category>; status: string; created_at: Date; updated_at: Date }) => ({
    id: t.id,
    number: t.number,
    subject: t.subject,
    category: t.category,
    status: t.status,
    createdAt: new Date(t.created_at).toISOString(),
    updatedAt: new Date(t.updated_at).toISOString(),
  });

  route(
    app,
    {
      method: "POST",
      url: "/v1/diagnostics/reports",
      tag: "diagnostics",
      summary: "Store a diagnostics report the user chose to send (redacted client-side; 256 KB max).",
      auth: "user",
      rateLimit: 10,
      body: z.object({ appVersion: z.string().max(32), os: z.string().max(64), report: z.record(z.string(), z.unknown()) }),
      response: z.object({ id: z.string() }),
      status: 201,
    },
    async ({ auth, body }) => {
      const json = JSON.stringify(body.report);
      if (json.length > 256 * 1024) throw badRequest("report_too_large");
      const row = await db()
        .insertInto("diag.reports")
        .values({ user_id: auth.userId, app_version: body.appVersion, os: body.os, report: json })
        .returning("id")
        .executeTakeFirstOrThrow();
      return { id: row.id };
    },
  );

  route(
    app,
    {
      method: "GET",
      url: "/v1/diagnostics/dns-leak/:token",
      tag: "diagnostics",
      summary: "Resolvers that queried <token>.dnscheck.<domain>. Integration point: needs the authoritative DNS probe service (not deployed), so it answers 501.",
      auth: "none",
      params: z.object({ token: z.string().regex(/^[a-z0-9]{16,64}$/) }),
    },
    async () => {
      throw notImplemented("dns_probe_not_deployed", "the DNS leak probe service is not deployed");
    },
  );

  // Ticket creation is multipart (attachments), so it's a plain route.
  app.post("/v1/support/tickets", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    const auth = await requireUser(req);
    if (!req.isMultipart()) throw badRequest("multipart_required");
    const fields: Record<string, string> = {};
    const files: { filename: string; mimetype: string; data: Buffer }[] = [];
    for await (const part of req.parts({ limits: { files: MAX_FILES, fileSize: MAX_FILE_BYTES, fields: 10, fieldSize: 64 * 1024 } })) {
      if (part.type === "file") {
        if (!ALLOWED_TYPES.has(part.mimetype)) throw badRequest("attachment_type_not_allowed", part.mimetype);
        const data = await part.toBuffer();
        if (part.file.truncated) throw badRequest("attachment_too_large");
        files.push({ filename: part.filename.replace(/[^\w.\- ]/g, "_").slice(0, 120), mimetype: part.mimetype, data });
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    const parsed = z
      .object({
        subject: z.string().trim().min(3).max(140),
        category: Category,
        description: z.string().trim().min(10).max(10_000),
        diagnosticReportId: z.uuid().optional(),
      })
      .safeParse(fields);
    if (!parsed.success) throw badRequest("invalid_request", "invalid ticket", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    const body = parsed.data;
    if (body.diagnosticReportId) {
      const own = await db().selectFrom("diag.reports").select("id").where("id", "=", body.diagnosticReportId).where("user_id", "=", auth.userId).executeTakeFirst();
      if (!own) throw badRequest("invalid_report");
    }
    const uploadDir = app.deps.config.UPLOAD_DIR;
    await mkdir(uploadDir, { recursive: true });
    const ticket = await db().transaction().execute(async (tx) => {
      const t = await tx
        .insertInto("support.tickets")
        .values({ user_id: auth.userId, subject: body.subject, category: body.category, diagnostic_report_id: body.diagnosticReportId ?? null })
        .returningAll()
        .executeTakeFirstOrThrow();
      const m = await tx.insertInto("support.messages").values({ ticket_id: t.id, author: "user", body: body.description }).returning("id").executeTakeFirstOrThrow();
      for (const f of files) {
        const key = randomUUID();
        await writeFile(join(uploadDir, key), f.data);
        await tx
          .insertInto("support.attachments")
          .values({
            ticket_id: t.id,
            message_id: m.id,
            filename: f.filename,
            content_type: f.mimetype,
            size_bytes: f.data.length,
            sha256: createHash("sha256").update(f.data).digest("hex"),
            storage_key: key,
          })
          .execute();
      }
      return t;
    });
    return reply.status(201).send(ticketDto(ticket));
  });

  route(app, { method: "GET", url: "/v1/support/tickets", tag: "support", summary: "The user's tickets.", auth: "user", response: z.array(TicketDto) },
    async ({ auth }) => {
      const rows = await db().selectFrom("support.tickets").selectAll().where("user_id", "=", auth.userId).orderBy("created_at", "desc").execute();
      return rows.map(ticketDto);
    });

  route(
    app,
    {
      method: "GET",
      url: "/v1/support/tickets/:id",
      tag: "support",
      summary: "A ticket with its messages and attachment metadata.",
      auth: "user",
      params: z.object({ id: z.uuid() }),
      response: TicketDto.extend({
        messages: z.array(z.object({ id: z.string(), author: z.string(), body: z.string(), createdAt: z.string() })),
        attachments: z.array(z.object({ id: z.string(), filename: z.string(), contentType: z.string(), sizeBytes: z.number() })),
      }),
    },
    async ({ auth, params }) => {
      const t = await db().selectFrom("support.tickets").selectAll().where("id", "=", params.id).where("user_id", "=", auth.userId).executeTakeFirst();
      if (!t) throw notFound();
      const messages = await db().selectFrom("support.messages").selectAll().where("ticket_id", "=", t.id).orderBy("created_at").execute();
      const attachments = await db().selectFrom("support.attachments").selectAll().where("ticket_id", "=", t.id).execute();
      return {
        ...ticketDto(t),
        messages: messages.map((m) => ({ id: m.id, author: m.author, body: m.body, createdAt: new Date(m.created_at).toISOString() })),
        attachments: attachments.map((a) => ({ id: a.id, filename: a.filename, contentType: a.content_type, sizeBytes: a.size_bytes })),
      };
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/support/tickets/:id/messages",
      tag: "support",
      summary: "Reply on a ticket.",
      auth: "user",
      rateLimit: 20,
      params: z.object({ id: z.uuid() }),
      body: z.object({ body: z.string().trim().min(1).max(10_000) }),
      status: 201,
    },
    async ({ auth, params, body }) => {
      const t = await db().selectFrom("support.tickets").select("id").where("id", "=", params.id).where("user_id", "=", auth.userId).executeTakeFirst();
      if (!t) throw notFound();
      await db().insertInto("support.messages").values({ ticket_id: t.id, author: "user", body: body.body }).execute();
      await db().updateTable("support.tickets").set({ status: "open", updated_at: app.deps.now() }).where("id", "=", t.id).execute();
    },
  );
}
