export const LOCALES = ["en", "ru", "de", "it"] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_COOKIE = "apexy_locale";
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", ru: "Русский", de: "Deutsch", it: "Italiano" };

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

/** The chosen language (cookie), else the browser's best match, else English. */
export function pickLocale(cookie: string | undefined, acceptLanguage: string | null): Locale {
  if (isLocale(cookie)) return cookie;
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { lang: (tag ?? "").toLowerCase().split("-")[0] ?? "", q: q ? Number(q.slice(2)) : 1 };
    })
    .filter((x) => x.lang && Number.isFinite(x.q) && x.q > 0)
    .sort((a, b) => b.q - a.q);
  return ranked.map((x) => x.lang).find(isLocale) ?? "en";
}
