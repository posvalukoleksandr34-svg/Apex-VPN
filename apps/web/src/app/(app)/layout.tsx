import { LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { logout } from "@/app/actions/auth";
import { SubmitButton } from "@/components/client";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { Logo } from "@/components/Logo";
import { getI18n } from "@/i18n/server";
import { currentUser } from "@/lib/dal";
import { NavLinks } from "./NavLinks";
import s from "./shell.module.css";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const [user, { m, locale }] = await Promise.all([currentUser(), getI18n()]);
  return (
    <div className={s.shell}>
      <aside className={s.sidebar}>
        <div className={s.brand}>
          <Logo size={30} />
          <span>Apexy VPN</span>
        </div>
        <NavLinks labels={m.nav} admin={user.role === "admin" ? m.admin.nav : undefined} />
        <div className={s.me}>
          <span className={s.email} title={user.email}>
            {user.email}
          </span>
          <div className={s.meActions}>
            <LanguageSwitcher locale={locale} label={m.common.language} />
            <form action={logout}>
              <SubmitButton working={m.common.working} variant="ghost" small>
                <LogOut size={14} aria-hidden />
                {m.common.signOut}
              </SubmitButton>
            </form>
          </div>
        </div>
      </aside>
      <main className={s.main}>
        <div className={s.content}>{children}</div>
        <footer className={s.footer}>{m.footer.privacy}</footer>
      </main>
    </div>
  );
}
