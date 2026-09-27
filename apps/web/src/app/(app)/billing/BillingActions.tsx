"use client";

import { ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { cancelPlan, checkout, openPortal, resumePlan, type BillingState } from "@/app/actions/billing";
import { Dialog, SubmitButton } from "@/components/client";
import { Button, Notice } from "@/components/ui";
import { fmt } from "@/i18n/format";
import type { Messages } from "@/i18n/messages/en";
import s from "./billing.module.css";

type T = { billing: Messages["billing"]; common: Messages["common"] };

export function PlanButton({ planId, label, disabled, primary, t }: { planId: string; label: string; disabled: boolean; primary: boolean; t: T }) {
  const [state, action] = useActionState<BillingState, FormData>(checkout, {});
  return (
    <form action={action} className={s.planAction}>
      <input type="hidden" name="planId" value={planId} />
      {state.error && <Notice tone="error">{state.error}</Notice>}
      <SubmitButton working={t.common.working} variant={primary ? "primary" : "secondary"} block disabled={disabled}>
        {label}
      </SubmitButton>
    </form>
  );
}

export function PortalButton({ t }: { t: T }) {
  const [state, action] = useActionState<BillingState>(openPortal, {});
  return (
    <form action={action}>
      {state.error && <Notice tone="error">{state.error}</Notice>}
      <SubmitButton working={t.common.working} variant="secondary">
        <ExternalLink size={15} aria-hidden />
        {t.billing.manage}
      </SubmitButton>
    </form>
  );
}

export function ResumePlan({ t }: { t: T }) {
  const [state, action] = useActionState<BillingState>(resumePlan, {});
  return (
    <form action={action}>
      {state.error && <Notice tone="error">{state.error}</Notice>}
      <SubmitButton working={t.common.working} variant="secondary" small>
        {t.billing.resume}
      </SubmitButton>
    </form>
  );
}

export function CancelPlan({ until, t }: { until: string; t: T }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<BillingState>(async (prev) => {
    const next = await cancelPlan(prev);
    if (!next.error) setOpen(false);
    return next;
  }, {});
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        {t.billing.cancel}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t.billing.cancelTitle}>
        <p>{fmt(t.billing.cancelBody, { date: until })}</p>
        {state.error && <Notice tone="error">{state.error}</Notice>}
        <form action={action} className={s.dialogButtons}>
          <Button onClick={() => setOpen(false)}>{t.billing.keep}</Button>
          <SubmitButton working={t.common.working} variant="danger">
            {t.billing.cancelConfirm}
          </SubmitButton>
        </form>
      </Dialog>
    </>
  );
}

/**
 * Back from Stripe Checkout. The payment is confirmed by a webhook moments
 * later, so until the plan shows as active the page checks again.
 */
export function CheckoutReturn({ result, activated, t }: { result: "success" | "cancel"; activated: boolean; t: T }) {
  const router = useRouter();
  const [tries, setTries] = useState(0);
  const waiting = result === "success" && !activated && tries < 20;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      setTries((n) => n + 1);
      router.refresh();
    }, 2000);
    return () => clearTimeout(timer);
  }, [waiting, tries, router]);
  if (result === "cancel") return <Notice tone="neutral">{t.billing.checkoutCancel}</Notice>;
  return activated ? <Notice tone="success">{t.billing.checkoutActive}</Notice> : <Notice tone="accent">{t.billing.checkoutSuccess}</Notice>;
}
