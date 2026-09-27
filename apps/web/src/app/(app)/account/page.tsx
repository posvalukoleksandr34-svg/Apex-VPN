import { KeyRound, MonitorSmartphone, ShieldCheck, TriangleAlert, UserRound } from "lucide-react";
import type { Metadata } from "next";
import { Badge, Card, PageHeader, ui } from "@/components/ui";
import { fmt, formatDate } from "@/i18n/format";
import { getI18n } from "@/i18n/server";
import { currentUser, userApi } from "@/lib/dal";
import type { SessionInfo } from "@/lib/types";
import { ChangePassword, DeleteAccount, SessionList } from "./AccountForms";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).m.account.title };
}

export default async function AccountPage() {
  const [user, sessions, { m, locale }] = await Promise.all([currentUser(), userApi<SessionInfo[]>("/v1/users/me/sessions"), getI18n()]);
  const t = { account: m.account, common: m.common };
  return (
    <>
      <PageHeader title={m.account.title} />
      <div className={ui.grid2}>
        <Card title={m.account.profile} icon={<UserRound size={18} aria-hidden />}>
          <div className={ui.stack}>
            <div className={ui.row}>
              <strong>{user.email}</strong>
              <Badge tone={user.emailVerified ? "success" : "warning"}>{user.emailVerified ? m.account.verified : m.account.unverified}</Badge>
            </div>
            <span className={ui.subtle}>{fmt(m.account.memberSince, { date: formatDate(locale, user.createdAt) })}</span>
          </div>
          <div className={ui.stack}>
            <span className={ui.row}>
              <ShieldCheck size={16} aria-hidden />
              <strong>{m.account.twoStep}</strong>
            </span>
            <span className={ui.muted}>{user.mfaEnabled ? m.account.twoStepOn : m.account.twoStepOff}</span>
          </div>
        </Card>
        <Card title={m.account.changePassword} icon={<KeyRound size={18} aria-hidden />}>
          <ChangePassword t={t} />
        </Card>
      </div>
      <Card title={m.account.sessions} icon={<MonitorSmartphone size={18} aria-hidden />}>
        <SessionList
          sessions={sessions.map((x) => ({ ...x, lastUsedLabel: fmt(m.account.lastUsed, { date: formatDate(locale, x.lastUsedOn) }) }))}
          t={t}
        />
      </Card>
      <Card title={m.account.danger} icon={<TriangleAlert size={18} aria-hidden />}>
        <p className={ui.muted}>{m.account.dangerBody}</p>
        <DeleteAccount t={t} />
      </Card>
    </>
  );
}
