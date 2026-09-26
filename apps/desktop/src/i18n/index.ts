import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import de from "./locales/de.json";
import en from "./locales/en.json";
import it from "./locales/it.json";
import ru from "./locales/ru.json";
import type { Language } from "@/state/types";

export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "ru", name: "Русский" },
  { code: "de", name: "Deutsch" },
  { code: "it", name: "Italiano" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

export function resolveLanguage(pref: Language): LanguageCode {
  if (pref !== "system") return pref;
  const nav = typeof navigator === "undefined" ? "en" : navigator.language.slice(0, 2).toLowerCase();
  return (LANGUAGES.find((l) => l.code === nav)?.code ?? "en") as LanguageCode;
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ru: { translation: ru },
    de: { translation: de },
    it: { translation: it },
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
