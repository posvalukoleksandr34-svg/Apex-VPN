import { CreditCard, ExternalLink, History, MonitorSmartphone, Receipt, UserRound } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, Notice } from "@/components/ui";
import { fmt, formatDate, formatMoney } from "@/i18n/format";
import type { Messages } from "@/i18n/messages/en";
import { getI18n } from "@/i18n/server";
import { ApiFailure } from "@/lib/api";
import { requireAdmin, userApi } from "@/lib/dal";
import { statusTone } from "@/lib/plan";
import type { AdminAction, AdminUserDetail } from "@/lib/types";
import s from "../../admin.module.css";
import { BanControl, DeviceLimitControl, EndSubscriptionControl, RefundControl, RemoveDevicesControl } from "./AdminControls";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).m.admin.account };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One line per staff action: what, and the detail that matters. */
function describe(a: AdminAction, m: Messages, locale: string): string {
  const d = a.detail;
  const label = m.admin.actions[a.action];
  switch (a.action) {
    case "ban":
      return typeof d.reason === "string" ? `${label}: ${d.reason}` : label;
    case "reset_devices":
      return `${label} (${Number(d.removed ?? 0)})`;
    case "device_limit": {
      const v = (x: unknown) => (x === null || x === undefined ? m.admin.limitDefault : String(x));
      return `${label}: ${v(d.from)} → ${v(d.to)}`;
    }
    case "refund":
      return `${label}: ${String(d.invoice ?? "")} · ${formatMoney(locale, Number(d.amountCents ?? 0), String(d.currency ?? "eur"))}`;
    case "cancel_subscription":
      return typeof d.withRefund === "string" ? `${label} (${d.withRefund})` : label;
    default:
      return label;
  }
}

export default async function AdminAccount({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireAdmin();
  const [{ id }, { m, locale }] = await Promise.all([params, getI18n()]);
  if (!UUID.test(id)) notFound();

  let d: AdminUserDetail;
  try {
    d = await userApi<AdminUserDetail>(`/v1/admin/users/${id}`);
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 404) notFound();
    if (e instanceof ApiFailure && e.code === "admin_mfa_required") return <Notice tone="warning">{m.admin.mfaRequired}</Notice>;
    throw e;
  }
  const { user, subscription: sub } = { user: d.user, subscription: d.user.subscription };
  const t = { admin: m.admin, common: m.common };
  const self = user.id === me.id;

  return (
    <>
      <header className={s.head}>
        <Link href="/admin" className={s.backLink}>
          ← {m.admin.back}
        </Link>
        <h1>{user.email}</h1>
        <div className={s.row}>
          {user.role === "admin" && <Badge tone="accent">{m.admin.staff}</Badge>}
          {user.isBanned && <Badge tone="error">{m.admin.banned}</Badge>}
          {!user.emailVerified && <Badge tone="neutral">{m.admin.unverified}</Badge>}
          {user.mfaEnabled && <Badge tone="success">{m.admin.mfaOn}</Badge>}
        </div>
      </header>

      <div className={s.grid}>
        <Card title={m.admin.account} icon={<UserRound size={18} aria-hidden />}>
          <dl className={s.facts}>
            <dt>{m.admin.email}</dt>
            <dd>{user.email}</dd>
            <dt>{m.admin.joined}</dt>
            <dd>{formatDate(locale, user.createdAt)}</dd>
            <dt>ID</dt>
            <dd>
              <code>{user.id}</code>
            </dd>
          </dl>
          {!self && <BanControl userId={user.id} email={user.email} banned={user.isBanned} t={t} />}
        </Card>

        <Card
          title={m.admin.subscription}
          icon={<CreditCard size={18} aria-hidden />}
          actions={sub ? <Badge tone={statusTone(sub.status)}>{m.status[sub.status]}</Badge> : <Badge tone="neutral">{m.status.none}</Badge>}
        >
          {sub ? (
            <div className={s.stack}>
              <strong>{(m.billing.planNames as Record<string, string>)[sub.planId] ?? sub.planName}</strong>
              <span className={s.sub}>
                {fmt(m.admin.periodEnds, { date: formatDate(locale, sub.currentPeriodEnd) })}
                {sub.cancelAtPeriodEnd && ` · ${m.admin.cancelsAtEnd}`}
              </span>
              <span className={s.sub}>{fmt(m.admin.provider, { provider: sub.provider === "stripe" ? "Stripe" : sub.provider })}</span>
            </div>
          ) : (
            <p className={s.sub}>{m.admin.noSubscription}</p>
          )}
          <div className={s.row}>
            {d.stripeCustomerUrl && (
              <a className={s.backLink} href={d.stripeCustomerUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={13} aria-hidden /> {m.admin.openStripe}
              </a>
            )}
            {sub && ["trialing", "active", "past_due", "incomplete"].includes(sub.status) && <EndSubscriptionControl userId={user.id} email={user.email} t={t} />}
          </div>
        </Card>
      </div>

      <Card title={m.admin.devices} icon={<MonitorSmartphone size={18} aria-hidden />}>
        <DeviceLimitControl
          userId={user.id}
          current={
            user.deviceLimit === null
              ? m.admin.limitNone
              : fmt(user.deviceLimitOverride === null ? m.admin.limitPlan : m.admin.limitCustom, { limit: user.deviceLimit })
          }
          overridden={user.deviceLimitOverride !== null}
          used={user.devices}
          t={t}
        />
        {d.devices.length === 0 ? (
          <p className={s.sub}>{m.admin.noDevices}</p>
        ) : (
          <>
            <ul className={s.list}>
              {d.devices.map((x) => (
                <li key={x.id}>
                  <span>
                    <strong>{x.name}</strong> <span className={s.sub}>· {(m.devices.platforms as Record<string, string>)[x.platform] ?? x.platform}</span>
                  </span>
                  <span className={s.sub}>
                    {x.connected ? m.devices.connected : fmt(m.devices.lastSeen, { date: formatDate(locale, x.lastSeenOn) })}
                  </span>
                </li>
              ))}
            </ul>
            <RemoveDevicesControl userId={user.id} email={user.email} t={t} />
          </>
        )}
      </Card>

      <Card title={m.admin.invoices} icon={<Receipt size={18} aria-hidden />}>
        {d.invoices.length === 0 ? (
          <p className={s.sub}>{m.admin.noInvoices}</p>
        ) : (
          <ul className={s.list}>
            {d.invoices.map((inv) => (
              <li key={inv.id}>
                <span className={s.stack}>
                  <span>
                    <code>{inv.number}</code> · {formatDate(locale, inv.issuedAt)}
                  </span>
                  <span className={s.sub}>{inv.description}</span>
                </span>
                <span className={s.row}>
                  <span className={s.num}>{formatMoney(locale, inv.amountCents, inv.currency)}</span>
                  {inv.refundedCents > 0 && <Badge tone="warning">{fmt(m.admin.refunded, { amount: formatMoney(locale, inv.refundedCents, inv.currency) })}</Badge>}
                  {inv.refundable && (
                    <RefundControl
                      userId={user.id}
                      invoiceId={inv.id}
                      number={inv.number}
                      currency={inv.currency}
                      remainingCents={inv.amountCents - inv.refundedCents}
                      remainingLabel={formatMoney(locale, inv.amountCents - inv.refundedCents, inv.currency)}
                      canCancel={!!sub && ["trialing", "active", "past_due"].includes(sub.status)}
                      t={t}
                    />
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={m.admin.log} icon={<History size={18} aria-hidden />}>
        {d.actions.length === 0 ? (
          <p className={s.sub}>{m.admin.noLog}</p>
        ) : (
          <ul className={`${s.list} ${s.log}`}>
            {d.actions.map((a) => (
              <li key={a.id}>
                <span>{describe(a, m, locale)}</span>
                <span className={s.sub}>
                  {formatDate(locale, a.createdAt)} · {fmt(m.admin.by, { email: a.adminEmail ?? m.admin.deletedStaff })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
