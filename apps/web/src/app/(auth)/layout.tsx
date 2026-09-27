import type { ReactNode } from "react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { Logo } from "@/components/Logo";
import { getI18n } from "@/i18n/server";
import s from "./auth.module.css";

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const { m, locale } = await getI18n();
  return (
    <main className={s.page}>
      <div className={s.column}>
        <div className={s.brand}>
          <Logo size={44} />
          <span>Apexy VPN</span>
        </div>
        <div className={s.card}>{children}</div>
        <footer className={s.footer}>
          <LanguageSwitcher locale={locale} label={m.common.language} />
          <span>{m.footer.privacy}</span>
        </footer>
      </div>
    </main>
  );
}
