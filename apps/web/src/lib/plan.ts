import type { Tone } from "@/components/ui";
import { fmt, formatDate } from "@/i18n/format";
import type { Messages } from "@/i18n/messages/en";
import type { Plan, Subscription } from "./types";

export function statusTone(status: Subscription["status"]): Tone {
  switch (status) {
    case "active":
    case "trialing":
      return "success";
    case "past_due":
    case "incomplete":
      return "warning";
    default:
      return "neutral";
  }
}

/** The one line that says what happens next with the plan. */
export function planDateLine(sub: Subscription, m: Messages, locale: string): string | null {
  const end = sub.currentPeriodEnd;
  if (!end) return null;
  const date = formatDate(locale, end);
  switch (sub.status) {
    case "trialing":
      return fmt(m.overview.trialEndsOn, { date });
    case "active":
      return fmt(sub.cancelAtPeriodEnd ? m.overview.endsOn : m.overview.renewsOn, { date });
    case "past_due":
      return m.overview.pastDue;
    case "canceled":
    case "expired":
      return fmt(m.overview.endedOn, { date });
    default:
      return null;
  }
}

/** Whether the account may use the service (and add devices) right now. */
export function hasAccess(sub: Subscription): boolean {
  return sub.status === "active" || sub.status === "trialing" || sub.status === "past_due";
}

/** A paid plan, not the trial, that currently grants access. */
export function hasPaidPlan(sub: Subscription): boolean {
  return hasAccess(sub) && !!sub.plan && sub.plan.period !== "trial";
}

/** A plan's name in the page's language; plans added later fall back to their stored name. */
export function planName(plan: Plan, m: Messages): string {
  return (m.billing.planNames as Record<string, string>)[plan.id] ?? plan.name;
}
