import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import s from "./Feedback.module.css";

export type BadgeTone = "neutral" | "success" | "pending" | "warning" | "error" | "accent" | "outline";

export function Badge({ tone = "neutral", children, dot, pulse, title }: { tone?: BadgeTone; children: ReactNode; dot?: boolean; pulse?: boolean; title?: string }) {
  return (
    <span className={s.badge} data-tone={tone} title={title}>
      {dot ? <StatusDot pulse={pulse} /> : null}
      {children}
    </span>
  );
}

/** Coloured by its parent's `color`; pulses for in-progress states. */
export function StatusDot({ pulse, style }: { pulse?: boolean; style?: CSSProperties }) {
  return <span className={s.dot} data-pulse={pulse ? "true" : undefined} style={style} aria-hidden />;
}

export function Banner({ tone = "neutral", icon, children, action }: { tone?: "neutral" | "warning" | "error" | "accent"; icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  const fallback = tone === "error" ? <CircleAlert size={18} /> : tone === "warning" ? <TriangleAlert size={18} /> : <Info size={18} />;
  return (
    <div className={s.banner} data-tone={tone} role={tone === "error" || tone === "warning" ? "alert" : "status"}>
      {icon ?? fallback}
      <div className={s.bannerText}>{children}</div>
      {action}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: ReactNode; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className={s.empty}>
      <div className={s.emptyIcon} aria-hidden>
        {icon}
      </div>
      <div className={s.emptyTitle}>{title}</div>
      {body ? <p className={s.emptyBody}>{body}</p> : null}
      {action ? <div style={{ marginTop: "var(--space-3)" }}>{action}</div> : null}
    </div>
  );
}

/**
 * Every error the user sees: title, what happened, likely cause, what to do,
 * plus retry and diagnostics when they make sense.
 */
export function ErrorState({
  title,
  explanation,
  cause,
  action,
  onRetry,
  onDiagnostics,
  extra,
}: {
  title: ReactNode;
  explanation: ReactNode;
  cause?: ReactNode;
  action?: ReactNode;
  onRetry?(): void;
  onDiagnostics?(): void;
  extra?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className={s.errorState} role="alert">
      <div className={s.errorTitle}>
        <CircleAlert size={20} aria-hidden />
        {title}
      </div>
      <dl className={s.errorGrid}>
        <dt>{t("errors.labels.explanation")}</dt>
        <dd>{explanation}</dd>
        {cause ? (
          <>
            <dt>{t("errors.labels.cause")}</dt>
            <dd>{cause}</dd>
          </>
        ) : null}
        {action ? (
          <>
            <dt>{t("errors.labels.action")}</dt>
            <dd>{action}</dd>
          </>
        ) : null}
      </dl>
      {onRetry || onDiagnostics || extra ? (
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
          {onRetry ? (
            <Button variant="primary" size="sm" onClick={onRetry}>
              {t("actions.retry")}
            </Button>
          ) : null}
          {onDiagnostics ? (
            <Button size="sm" onClick={onDiagnostics}>
              {t("actions.open_diagnostics")}
            </Button>
          ) : null}
          {extra}
        </div>
      ) : null}
    </div>
  );
}

export function Skeleton({ width = "100%", height = 14, style }: { width?: number | string; height?: number | string; style?: CSSProperties }) {
  return <span className={s.skeleton} style={{ width, height, ...style }} aria-hidden />;
}

export function Spinner({ label }: { label: string }) {
  return <span className={s.spinner} role="status" aria-label={label} />;
}

/** "Ctrl+Shift+C" → individual key caps. */
export function Kbd({ combo }: { combo: string }) {
  const keys = combo.split("+").filter(Boolean);
  return (
    <span className={s.kbd} aria-label={combo}>
      {keys.map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  );
}
