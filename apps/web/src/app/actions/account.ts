"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getI18n } from "@/i18n/server";
import { storeSession, userApi } from "@/lib/dal";
import { describeFailure } from "@/lib/errors";

export interface AccountState {
  error?: string;
  notice?: string;
}

const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
};

export async function changePassword(_prev: AccountState, form: FormData): Promise<AccountState> {
  const { m } = await getI18n();
  try {
    await userApi("/v1/users/me/password", { method: "POST", body: { currentPassword: text(form, "current"), newPassword: text(form, "password") } });
  } catch (e) {
    return { error: describeFailure(e, m, m.account.errors) };
  }
  revalidatePath("/account");
  return { notice: m.account.passwordChanged };
}

export async function signOutSession(_prev: AccountState, form: FormData): Promise<AccountState> {
  const { m } = await getI18n();
  const id = text(form, "id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { error: m.common.unexpected };
  try {
    await userApi(`/v1/users/me/sessions/${id}`, { method: "DELETE" });
  } catch (e) {
    return { error: describeFailure(e, m) };
  }
  revalidatePath("/account");
  return {};
}

export async function signOutOthers(_prev: AccountState): Promise<AccountState> {
  const { m } = await getI18n();
  try {
    await userApi("/v1/users/me/sessions/revoke-others", { method: "POST" });
  } catch (e) {
    return { error: describeFailure(e, m) };
  }
  revalidatePath("/account");
  return { notice: m.account.othersSignedOut };
}

/** Cancels the subscription and deletes everything; the API refuses if billing can't be stopped. */
export async function deleteAccount(_prev: AccountState, form: FormData): Promise<AccountState> {
  const { m } = await getI18n();
  try {
    await userApi("/v1/users/me", { method: "DELETE", body: { password: text(form, "password") } });
  } catch (e) {
    return { error: describeFailure(e, m, m.account.errors) };
  }
  await storeSession(null);
  redirect("/login?deleted=1");
}
