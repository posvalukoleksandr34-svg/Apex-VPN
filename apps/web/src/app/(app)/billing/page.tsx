import { CreditCard, Receipt } from "lucide-react";
import type { Metadata } from "next";
import { Badge, Card, Notice, PageHeader, ui } from "@/components/ui";
import { fmt, formatDate, formatMoney } from "@/i18n/format";
import { getI18n } from "@/i18n/server";
import { publicApi, userApi } from "@/lib/dal";
import { hasAccess, hasPaidPlan, planDateLine, planName, statusTone } from "@/lib/plan";
import type { Invoice, Plan, Subscription } from "@/lib/types";
import { CancelPlan, CheckoutReturn, PlanButton, PortalButton, ResumePlan } from "./BillingActions";
import s from "./billing.module.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).m.billing.title };
}

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function BillingPage({ searchParams }: { searchParams: Search }) {
  const [sub, plans, invoices, { m, locale }, q] = await Promise.all([
    userApi<Subscription>("/v1/subscription"),
    publicApi<Plan[]>("/v1/subscription/plans"),
    userApi<Invoice[]>("/v1/subscription/invoices"),
    getI18n(),
    searchParams,
  ]);
  const paid = hasPaidPlan(sub);
  const dateLine = planDateLine(sub, m, locale);
  const checkout = q.checkout === "success" || q.checkout === "cancel" ? q.checkout : null;
  const t = { billing: m.billing, common: m.common };
  const price = (p: Plan) => formatMoney(locale, p.priceCents, p.currency);
  return (
    <>
      <PageHeader title={m.billing.title} />
      {checkout && <CheckoutReturn result={checkout} activated={paid} t={t} />}

      <Card title={m.billing.current} icon={<CreditCard size={18} aria-hidden />} actions={<Badge tone={statusTone(sub.status)}>{m.status[sub.status]}</Badge>}>
        {sub.plan && sub.status !== "none" ? (
          <div className={ui.stack}>
            <span className={ui.big}>{planName(sub.plan, m)}</span>
            {dateLine && <span className={ui.muted}>{dateLine}</span>}
            {sub.paymentMethod && (
              <span className={ui.subtle}>
                {m.billing.paymentMethod}:{" "}
                {fmt(m.billing.cardEnding, {
                  brand: sub.paymentMethod.brand.toUpperCase(),
                  last4: sub.paymentMethod.last4,
                  month: String(sub.paymentMethod.expMonth).padStart(2, "0"),
                  year: sub.paymentMethod.expYear,
                })}
              </span>
            )}
          </div>
        ) : (
          <p className={ui.muted}>{m.billing.noPlan}</p>
        )}
        {sub.status === "trialing" && <Notice tone="accent">{m.billing.trialNote}</Notice>}
        {sub.cancelAtPeriodEnd && sub.currentPeriodEnd && hasAccess(sub) && (
          <Notice tone="warning" action={<ResumePlan t={t} />}>
            {fmt(m.billing.cancelsOn, { date: formatDate(locale, sub.currentPeriodEnd) })}
          </Notice>
        )}
        {(sub.provider === "stripe" || (paid && !sub.cancelAtPeriodEnd)) && (
          <div className={ui.row}>
            {sub.provider === "stripe" && <PortalButton t={t} />}
            {paid && !sub.cancelAtPeriodEnd && sub.currentPeriodEnd && <CancelPlan until={formatDate(locale, sub.currentPeriodEnd)} t={t} />}
          </div>
        )}
      </Card>

      <section className={s.plans} aria-label={m.billing.plans}>
        {plans.map((p) => {
          const current = paid && sub.plan?.id === p.id;
          return (
            <div key={p.id} className={s.plan} data-current={current || undefined}>
              <div className={s.planHead}>
                <h2>{planName(p, m)}</h2>
                {current && <Badge tone="success">{m.billing.currentPlan}</Badge>}
              </div>
              <div className={s.price}>{fmt(p.period === "year" ? m.billing.perYear : m.billing.perMonth, { price: price(p) })}</div>
              {p.period === "year" && (
                <span className={ui.subtle}>{fmt(m.billing.monthlyEquivalent, { price: formatMoney(locale, Math.round(p.priceCents / 12), p.currency) })}</span>
              )}
              <ul className={s.perks}>
                <li>{fmt(m.billing.devicesIncluded, { count: p.deviceLimit })}</li>
                <li>{m.billing.everything}</li>
              </ul>
              <PlanButton planId={p.id} label={current ? m.billing.currentPlan : paid ? m.billing.switchTo : m.billing.choose} disabled={current} primary={!paid} t={t} />
            </div>
          );
        })}
      </section>

      <Card title={m.billing.invoices} icon={<Receipt size={18} aria-hidden />}>
        {invoices.length === 0 ? (
          <p className={ui.muted}>{m.billing.noInvoices}</p>
        ) : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>{m.billing.invoice}</th>
                  <th>{m.billing.date}</th>
                  <th>{m.billing.amount}</th>
                  <th>{m.billing.invoiceStatus}</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td>
                      <span className={s.mono}>{inv.number}</span>
                      <span className={s.desc}>{inv.description}</span>
                    </td>
                    <td>{formatDate(locale, inv.issuedAt)}</td>
                    <td className={s.num}>{formatMoney(locale, inv.amountCents, inv.currency)}</td>
                    <td>
                      <Badge tone={inv.status === "paid" ? "success" : inv.status === "open" ? "warning" : "neutral"}>
                        {(m.billing.invoiceStates as Record<string, string>)[inv.status] ?? inv.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
