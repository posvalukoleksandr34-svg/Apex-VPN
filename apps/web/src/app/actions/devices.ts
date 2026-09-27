"use server";

import { revalidatePath } from "next/cache";
import { getI18n } from "@/i18n/server";
import { userApi } from "@/lib/dal";
import { describeFailure } from "@/lib/errors";
import { DEVICE_PLATFORMS, type Device, type Registration } from "@/lib/types";

export type DeviceResult = { ok: true; registration: Registration } | { ok: false; error: string };
export type Done = { ok: true } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_KEY = /^[A-Za-z0-9+/]{43}=$/;

function cleanName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const n = name.trim().replace(/\s+/g, " ");
  return n.length >= 1 && n.length <= 64 ? n : null;
}

/**
 * Registers a device with a public key made in the browser. The private
 * key never comes here.
 */
export async function createDevice(input: { name: string; platform: string; publicKey: string }): Promise<DeviceResult> {
  const { m } = await getI18n();
  const name = cleanName(input.name);
  if (!name || !(DEVICE_PLATFORMS as readonly string[]).includes(input.platform) || !PUBLIC_KEY.test(input.publicKey)) {
    return { ok: false, error: m.common.unexpected };
  }
  try {
    const res = await userApi<{ device: Device; registration: Registration }>("/v1/devices", {
      method: "POST",
      body: { name, platform: input.platform, publicKey: input.publicKey },
    });
    revalidatePath("/devices");
    revalidatePath("/dashboard");
    return { ok: true, registration: res.registration };
  } catch (e) {
    return { ok: false, error: describeFailure(e, m) };
  }
}

/** A new key for a device (a new config): the old one stops working at once. */
export async function replaceDeviceKey(id: string, publicKey: string): Promise<DeviceResult> {
  const { m } = await getI18n();
  if (!UUID.test(id) || !PUBLIC_KEY.test(publicKey)) return { ok: false, error: m.common.unexpected };
  try {
    const registration = await userApi<Registration>(`/v1/devices/${id}/key`, { method: "PUT", body: { publicKey } });
    revalidatePath("/devices");
    return { ok: true, registration };
  } catch (e) {
    return { ok: false, error: describeFailure(e, m) };
  }
}

export async function renameDevice(id: string, name: string): Promise<Done> {
  const { m } = await getI18n();
  const clean = cleanName(name);
  if (!UUID.test(id) || !clean) return { ok: false, error: m.common.unexpected };
  try {
    await userApi(`/v1/devices/${id}`, { method: "PATCH", body: { name: clean } });
    revalidatePath("/devices");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: describeFailure(e, m) };
  }
}

export async function removeDevice(id: string): Promise<Done> {
  const { m } = await getI18n();
  if (!UUID.test(id)) return { ok: false, error: m.common.unexpected };
  try {
    await userApi(`/v1/devices/${id}`, { method: "DELETE" });
    revalidatePath("/devices");
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: describeFailure(e, m) };
  }
}
