"use server";

import { revalidatePath } from "next/cache";
import { getI18n } from "@/i18n/server";
import { userApi } from "@/lib/dal";
import { describeFailure } from "@/lib/errors";

/**
 * Staff actions. The API checks that the caller is an admin (and records
 * each change); these only validate input and pass it on.
 */
export type Done = { ok: true } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run(userId: string, call: () => Promise<unknown>): Promise<Done> {
  const { m } = await getI18n();
  try {
    await call();
  } catch (e) {
    return { ok: false, error: describeFailure(e, m, m.admin.errors) };
  }
  revalidatePath(`/admin/users/${userId}`);
  revalidatePath("/admin");
  return { ok: true };
}

async function invalid(): Promise<Done> {
  return { ok: false, error: (await getI18n()).m.common.unexpected };
}

export async function setBan(userId: string, banned: boolean, reason: string): Promise<Done> {
  if (!UUID.test(userId)) return invalid();
  const why = reason.trim().slice(0, 200);
  return run(userId, () => userApi(`/v1/admin/users/${userId}/ban`, { method: "POST", body: { banned, ...(why ? { reason: why } : {}) } }));
}

export async function removeAllDevices(userId: string): Promise<Done> {
  if (!UUID.test(userId)) return invalid();
  return run(userId, () => userApi(`/v1/admin/users/${userId}/devices/reset`, { method: "POST" }));
}

export async function setDeviceLimit(userId: string, limit: number | null): Promise<Done> {
  if (!UUID.test(userId) || (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > 100))) return invalid();
  return run(userId, () => userApi(`/v1/admin/users/${userId}/device-limit`, { method: "PUT", body: { limit } }));
}

export async function endSubscription(userId: string): Promise<Done> {
  if (!UUID.test(userId)) return invalid();
  return run(userId, () => userApi(`/v1/admin/users/${userId}/cancel-subscription`, { method: "POST" }));
}

export async function refundInvoice(userId: string, invoiceId: string, amountCents: number, cancelSubscription: boolean): Promise<Done> {
  if (!UUID.test(userId) || !UUID.test(invoiceId) || !Number.isInteger(amountCents) || amountCents < 1) return invalid();
  return run(userId, () => userApi(`/v1/admin/invoices/${invoiceId}/refund`, { method: "POST", body: { amountCents, cancelSubscription } }));
}
