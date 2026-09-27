"use server";

import { cookies } from "next/headers";
import { currentSession, userApi } from "@/lib/dal";
import { secureCookies } from "@/lib/env";
import { isLocale, LOCALE_COOKIE } from "@/i18n/locale";

/** Remembers the language for this browser, and for the account's emails when signed in. */
export async function setLocale(locale: string): Promise<void> {
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: 365 * 24 * 3600, sameSite: "lax", httpOnly: true, secure: secureCookies() });
  if (await currentSession()) {
    await userApi("/v1/users/me", { method: "PATCH", body: { locale } }).catch(() => undefined);
  }
}
