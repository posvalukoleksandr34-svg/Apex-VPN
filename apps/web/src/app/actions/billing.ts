"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getI18n } from "@/i18n/server";
import { userApi } from "@/lib/dal";
import { describeFailure } from "@/lib/errors";

export interface BillingState {
  error?: string;
}

/** Stripe's pages only: a checkout or portal URL from the API must be one of these. */
function stripePage(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "checkout.stripe.com" || u.hostname === "billing.stripe.com") ? u.toString() : null;
  } catch {
    return null;
  }
}

export async function checkout(_prev: BillingState, form: FormData): Promise<BillingState> {
  const { m } = await getI18n();
  const planId = form.get("planId");
  if (typeof planId !== "string" || !/^[a-z0-9_-]{1,32}$/.test(planId)) return { error: m.billing.errors.unknown_plan };
  let res: { kind: "redirect" | "activated"; url?: string };
  try {
    res = await userApi("/v1/subscription/checkout", { method: "POST", body: { planId, returnTo: "web" } });
  } catch (e) {
    return { error: describeFailure(e, m) };
  }
  if (res.kind === "activated") {
    revalidatePath("/", "layout");
    redirect("/billing?checkout=success");
  }
  const url = res.url && stripePage(res.url);
  if (!url) return { error: m.common.unexpected };
  redirect(url);
}

export async function openPortal(_prev: BillingState): Promise<BillingState> {
  const { m } = await getI18n();
  let url: string | null;
  try {
    url = stripePage((await userApi<{ url: string }>("/v1/subscription/portal", { method: "POST", body: { returnTo: "web" } })).url);
  } catch (e) {
    return { error: describeFailure(e, m) };
  }
  if (!url) return { error: m.common.unexpected };
  redirect(url);
}

export async function cancelPlan(_prev: BillingState): Promise<BillingState> {
  const { m } = await getI18n();
  try {
    await userApi("/v1/subscription/cancel", { method: "POST" });
  } catch (e) {
    return { error: describeFailure(e, m) };
  }
  revalidatePath("/billing");
  return {};
}

export async function resumePlan(_prev: BillingState): Promise<BillingState> {
  const { m } = await getI18n();
  try {
    await userApi("/v1/subscription/resume", { method: "POST" });
  } catch (e) {
    return { error: describeFailure(e, m) };
  }
  revalidatePath("/billing");
  return {};
}
