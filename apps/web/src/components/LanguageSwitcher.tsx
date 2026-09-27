"use client";

import { Languages } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setLocale } from "@/app/actions/locale";
import { LOCALE_NAMES, LOCALES, type Locale } from "@/i18n/locale";
import s from "./LanguageSwitcher.module.css";

export function LanguageSwitcher({ locale, label }: { locale: Locale; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <label className={s.switcher}>
      <Languages size={14} aria-hidden />
      <span className="visually-hidden">{label}</span>
      <select
        value={locale}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          start(async () => {
            await setLocale(next);
            router.refresh();
          });
        }}
      >
        {LOCALES.map((l: Locale) => (
          <option key={l} value={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
