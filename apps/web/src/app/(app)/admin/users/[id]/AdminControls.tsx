"use client";

import { Ban, KeyRound, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { useId, useState, useTransition, type ReactNode } from "react";
import { endSubscription, refundInvoice, removeAllDevices, setBan, setDeviceLimit, type Done } from "@/app/actions/admin";
import { Dialog } from "@/components/client";
import { Button, Field, Notice, ui } from "@/components/ui";
import { fmt } from "@/i18n/format";
import type { Messages } from "@/i18n/messages/en";
import s from "../../admin.module.css";

type T = { admin: Messages["admin"]; common: Messages["common"] };

/** A button that opens a confirmation; the dialog shows the action's own error, if any. */
function Confirm({
  trigger,
  title,
  body,
  confirm,
  danger,
  action,
  children,
  t,
}: {
  trigger: (open: () => void) => ReactNode;
  title: string;
  body: string;
  confirm: string;
  danger?: boolean;
  action: (form: FormData) => Promise<Done> | Done;
  children?: ReactNode;
  t: T;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const close = () => {
    setOpen(false);
    setError(null);
  };
  return (
    <>
      {trigger(() => setOpen(true))}
      <Dialog open={open} onClose={close} title={title}>
        <form
          className={ui.stack}
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            start(async () => {
              const r = await action(form);
              if (r.ok) close();
              else setError(r.error);
            });
          }}
        >
          <p className={ui.muted}>{body}</p>
          {children}
          {error && <Notice tone="error">{error}</Notice>}
          <div className={s.row}>
            <Button onClick={close}>{t.common.cancel}</Button>
            <Button type="submit" variant={danger ? "danger" : "primary"} disabled={pending}>
              {pending ? t.common.working : confirm}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

export function BanControl({ userId, email, banned, t }: { userId: string; email: string; banned: boolean; t: T }) {
  return banned ? (
    <Confirm
      t={t}
      trigger={(open) => (
        <div>
          <Button onClick={open}>
            <Undo2 size={15} aria-hidden />
            {t.admin.unban}
          </Button>
        </div>
      )}
      title={fmt(t.admin.unbanTitle, { email })}
      body={t.admin.unbanBody}
      confirm={t.admin.unban}
      action={() => setBan(userId, false, "")}
    />
  ) : (
    <Confirm
      t={t}
      trigger={(open) => (
        <div>
          <Button variant="danger" onClick={open}>
            <Ban size={15} aria-hidden />
            {t.admin.ban}
          </Button>
        </div>
      )}
      title={fmt(t.admin.banTitle, { email })}
      body={t.admin.banBody}
      confirm={t.admin.ban}
      danger
      action={(form) => setBan(userId, true, String(form.get("reason") ?? ""))}
    >
      <Field label={t.admin.banReason} name="reason" maxLength={200} autoFocus />
    </Confirm>
  );
}

export function EndSubscriptionControl({ userId, email, t }: { userId: string; email: string; t: T }) {
  return (
    <Confirm
      t={t}
      trigger={(open) => (
        <Button variant="danger" small onClick={open}>
          {t.admin.endNow}
        </Button>
      )}
      title={fmt(t.admin.endNowTitle, { email })}
      body={t.admin.endNowBody}
      confirm={t.admin.endNow}
      danger
      action={() => endSubscription(userId)}
    />
  );
}

export function RemoveDevicesControl({ userId, email, t }: { userId: string; email: string; t: T }) {
  return (
    <Confirm
      t={t}
      trigger={(open) => (
        <div>
          <Button variant="danger" small onClick={open}>
            <Trash2 size={14} aria-hidden />
            {t.admin.removeAll}
          </Button>
        </div>
      )}
      title={fmt(t.admin.removeAllTitle, { email })}
      body={t.admin.removeAllBody}
      confirm={t.admin.removeAll}
      danger
      action={() => removeAllDevices(userId)}
    />
  );
}

export function DeviceLimitControl({ userId, current, overridden, used, t }: { userId: string; current: string; overridden: boolean; used: number; t: T }) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const apply = (limit: number | null) =>
    start(async () => {
      const r = await setDeviceLimit(userId, limit);
      setError(r.ok ? null : r.error);
    });
  return (
    <div className={ui.stack}>
      <span>
        <strong>{t.admin.deviceLimit}:</strong> {current} <span className={s.sub}>· {used}</span>
      </span>
      <form
        className={s.row}
        onSubmit={(e) => {
          e.preventDefault();
          const v = Number(new FormData(e.currentTarget).get("limit"));
          if (Number.isInteger(v) && v >= 0 && v <= 100) apply(v);
        }}
      >
        <label htmlFor={id} className="visually-hidden">
          {t.admin.newLimit}
        </label>
        <input id={id} name="limit" type="number" min={0} max={100} step={1} required placeholder={t.admin.newLimit} className={s.limitInput} />
        <Button type="submit" small disabled={pending}>
          <KeyRound size={14} aria-hidden />
          {t.admin.setLimit}
        </Button>
        {overridden && (
          <Button small variant="ghost" disabled={pending} onClick={() => apply(null)}>
            <RotateCcw size={14} aria-hidden />
            {t.admin.resetLimit}
          </Button>
        )}
      </form>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

export function RefundControl({
  userId,
  invoiceId,
  number,
  currency,
  remainingCents,
  remainingLabel,
  canCancel,
  t,
}: {
  userId: string;
  invoiceId: string;
  number: string;
  currency: string;
  remainingCents: number;
  remainingLabel: string;
  canCancel: boolean;
  t: T;
}) {
  return (
    <Confirm
      t={t}
      trigger={(open) => (
        <Button small onClick={open}>
          {t.admin.refund}
        </Button>
      )}
      title={fmt(t.admin.refundTitle, { number })}
      body={fmt(t.admin.refundUpTo, { amount: remainingLabel })}
      confirm={t.admin.refund}
      danger
      action={(form) => {
        // "12,34" or "12.34" in the currency's main unit.
        const cents = Math.round(Number(String(form.get("amount") ?? "").trim().replace(",", ".")) * 100);
        if (!Number.isInteger(cents) || cents < 1 || cents > remainingCents) return { ok: false, error: fmt(t.admin.refundInvalid, { amount: remainingLabel }) };
        return refundInvoice(userId, invoiceId, cents, form.get("cancel") === "on");
      }}
    >
      <Field label={fmt(t.admin.refundAmount, { currency: currency.toUpperCase() })} name="amount" inputMode="decimal" defaultValue={(remainingCents / 100).toFixed(2)} required autoFocus />
      {canCancel && (
        <label className={s.row}>
          <input type="checkbox" name="cancel" />
          {t.admin.refundCancel}
        </label>
      )}
    </Confirm>
  );
}
