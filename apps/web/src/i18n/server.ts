import "server-only";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { LOCALE_COOKIE, pickLocale, type Locale } from "./locale";
import { de } from "./messages/de";
import { en, type Messages } from "./messages/en";
import { it } from "./messages/it";
import { ru } from "./messages/ru";

const dictionaries: Record<Locale, Messages> = { en, ru, de, it };

export const getI18n = cache(async (): Promise<{ locale: Locale; m: Messages }> => {
  const locale = pickLocale((await cookies()).get(LOCALE_COOKIE)?.value, (await headers()).get("accept-language"));
  return { locale, m: dictionaries[locale] };
});
