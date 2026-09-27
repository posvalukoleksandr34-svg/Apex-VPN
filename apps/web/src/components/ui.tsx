import clsx from "clsx";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import s from "./ui.module.css";

export type Tone = "success" | "warning" | "error" | "neutral" | "accent";
type Variant = "primary" | "secondary" | "ghost" | "danger";

export function buttonClass(variant: Variant = "secondary", opts: { small?: boolean; block?: boolean } = {}): string {
  return clsx(s.button, s[variant], opts.small && s.small, opts.block && s.block);
}

export function Button({ variant, small, block, className, ...props }: ComponentProps<"button"> & { variant?: Variant; small?: boolean; block?: boolean }) {
  return <button type="button" {...props} className={clsx(buttonClass(variant, { small, block }), className)} />;
}

export function ButtonLink({ variant, small, block, className, ...props }: ComponentProps<typeof Link> & { variant?: Variant; small?: boolean; block?: boolean }) {
  return <Link {...props} className={clsx(buttonClass(variant, { small, block }), className)} />;
}

export function Card({ title, icon, actions, children, className }: { title?: ReactNode; icon?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={clsx(s.card, className)}>
      {(title || actions) && (
        <div className={s.cardHead}>
          {title && (
            <h2 className={s.cardTitle}>
              {icon}
              {title}
            </h2>
          )}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={clsx(s.badge, s[`tone-${tone}`])}>{children}</span>;
}

const noticeIcons = { success: CheckCircle2, warning: AlertTriangle, error: XCircle, neutral: Info, accent: Info };

export function Notice({ tone, children, action }: { tone: Tone; children: ReactNode; action?: ReactNode }) {
  const Icon = noticeIcons[tone];
  return (
    <div className={clsx(s.notice, s[`tone-${tone}`])} role={tone === "error" ? "alert" : "status"}>
      <Icon size={16} aria-hidden />
      <div>{children}</div>
      {action}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  labelAction,
  code,
  ...input
}: ComponentProps<"input"> & { label: ReactNode; hint?: ReactNode; error?: ReactNode; labelAction?: ReactNode; code?: boolean }) {
  const id = input.id ?? input.name;
  return (
    <div className={s.field}>
      <div className={s.labelRow}>
        <label className={s.label} htmlFor={id}>
          {label}
        </label>
        {labelAction && <span className={s.labelAction}>{labelAction}</span>}
      </div>
      <input
        {...input}
        id={id}
        className={clsx(s.input, code && s.code)}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? `${id}-note` : undefined}
      />
      {error ? (
        <span id={`${id}-note`} className={s.error}>
          {error}
        </span>
      ) : hint ? (
        <span id={`${id}-note`} className={s.hint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function SelectField({ label, children, ...select }: ComponentProps<"select"> & { label: ReactNode }) {
  const id = select.id ?? select.name;
  return (
    <div className={s.field}>
      <label className={s.label} htmlFor={id}>
        {label}
      </label>
      <select {...select} id={id} className={s.select}>
        {children}
      </select>
    </div>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className={s.meter} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <div className={clsx(s.meterFill, value >= max && s.meterFull)} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className={s.pageHeader}>
      <div>
        <h1>{title}</h1>
        {subtitle && <p className={s.muted}>{subtitle}</p>}
      </div>
      {actions && <div className={s.row}>{actions}</div>}
    </header>
  );
}

export const ui = s;
