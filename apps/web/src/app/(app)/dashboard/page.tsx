import { CreditCard, Download, MonitorSmartphone, Smartphone } from "lucide-react";
import type { Metadata } from "next";
import { Badge, ButtonLink, Card, Meter, Notice, PageHeader, ui } from "@/components/ui";
import { fmt } from "@/i18n/format";
import { getI18n } from "@/i18n/server";
import { currentUser, userApi } from "@/lib/dal";
import { env } from "@/lib/env";
import { hasAccess, planDateLine, planName, statusTone } from "@/lib/plan";
import type { Subscription } from "@/lib/types";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).m.overview.title };
}

export default async function Overview() {
  const [user, sub, { m, locale }] = await Promise.all([currentUser(), userApi<Subscription>("/v1/subscription"), getI18n()]);
  const limit = sub.deviceLimit ?? sub.plan?.deviceLimit ?? 0;
  const dateLine = planDateLine(sub, m, locale);
  const windows = env().DOWNLOAD_URL_WINDOWS;
  return (
    <>
      <PageHeader title={m.overview.title} subtitle={fmt(m.overview.signedInAs, { email: user.email })} />
      {!user.emailVerified && (
        <Notice tone="warning" action={<ButtonLink href="/verify" small>{m.overview.verifyNow}</ButtonLink>}>
          {m.overview.unverified}
        </Notice>
      )}
      <div className={ui.grid2}>
        <Card title={m.overview.plan} icon={<CreditCard size={18} aria-hidden />} actions={<Badge tone={statusTone(sub.status)}>{m.status[sub.status]}</Badge>}>
          {sub.plan && sub.status !== "none" ? (
            <div className={ui.stack}>
              <span className={ui.big}>{planName(sub.plan, m)}</span>
              {dateLine && <span className={ui.muted}>{dateLine}</span>}
            </div>
          ) : (
            <span className={ui.muted}>{m.overview.noPlan}</span>
          )}
          <div className={ui.row}>
            <ButtonLink href="/billing" variant={hasAccess(sub) ? "secondary" : "primary"}>
              {hasAccess(sub) ? m.overview.manageBilling : m.overview.choosePlan}
            </ButtonLink>
          </div>
        </Card>
        <Card title={m.overview.devices} icon={<MonitorSmartphone size={18} aria-hidden />}>
          <div className={ui.stack}>
            <span className={ui.big}>{fmt(m.overview.devicesUsed, { used: sub.devicesUsed, limit })}</span>
            <Meter value={sub.devicesUsed} max={limit} label={m.overview.devices} />
          </div>
          <div className={ui.row}>
            {hasAccess(sub) && sub.devicesUsed < limit ? (
              <ButtonLink href="/devices?add=1" variant="primary">
                {m.overview.addDevice}
              </ButtonLink>
            ) : (
              <ButtonLink href="/devices">{m.nav.devices}</ButtonLink>
            )}
          </div>
        </Card>
      </div>
      <Card title={m.overview.getApps} icon={<Download size={18} aria-hidden />}>
        <div className={ui.grid2}>
          <div className={ui.stack}>
            <h3>{m.overview.windows}</h3>
            <p className={ui.muted}>{m.overview.windowsBody}</p>
            {windows ? (
              <div className={ui.row}>
                <a className={`${ui.button} ${ui.secondary}`} href={windows} rel="noopener">
                  <Download size={16} aria-hidden />
                  {m.overview.download}
                </a>
              </div>
            ) : (
              <p className={ui.subtle}>{m.overview.downloadSoon}</p>
            )}
          </div>
          <div className={ui.stack}>
            <h3>{m.overview.phones}</h3>
            <p className={ui.muted}>{m.overview.phonesBody}</p>
            <div className={ui.row}>
              <ButtonLink href="/devices?add=1">
                <Smartphone size={16} aria-hidden />
                {m.overview.addDevice}
              </ButtonLink>
            </div>
          </div>
        </div>
      </Card>
    </>
  );
}
