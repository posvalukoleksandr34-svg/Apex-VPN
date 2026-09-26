import type { Kysely } from "kysely";
import type { DB, NotificationType } from "../../db/schema.js";
import type { AppDeps } from "../../deps.js";

/** Records an in-app notification (the desktop app mirrors them as OS notifications per the user's preferences). */
export async function notify(
  deps: AppDeps,
  userId: string,
  type: NotificationType,
  title: string,
  body: string,
  data: Record<string, unknown> = {},
  db: Kysely<DB> = deps.database.db,
): Promise<void> {
  await db
    .insertInto("notify.notifications")
    .values({ user_id: userId, type, title, body, data: JSON.stringify(data) })
    .execute();
}
