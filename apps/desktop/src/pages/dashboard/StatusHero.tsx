import { Power, ShieldAlert, ShieldCheck, ShieldOff, ShieldX } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge, Button } from "@/design";
import { describe, type ActionId } from "@/features/connection/status";
import { useActionRunner } from "@/features/connection/useActionRunner";
import { useNow } from "@/lib/hooks";
import { useApp } from "@/state/store";
import s from "./Dashboard.module.css";

const ICON = {
  success: ShieldCheck,
  pending: ShieldAlert,
  warning: ShieldAlert,
  error: ShieldX,
  neutral: ShieldOff,
} as const;

/** Big status ring, headline and the single primary action. */
export function StatusHero() {
  const { t } = useTranslation();
  const service = useApp((st) => st.service);
  const tunnel = useApp((st) => st.tunnel);
  // Retry countdowns tick; everything else only changes on service events.
  const now = useNow(1000, tunnel?.state === "connecting" || tunnel?.state === "reconnecting");
  const view = describe(service, tunnel, now);
  const run = useActionRunner();
  const Icon = ICON[view.tone];

  const buttonVariant = (a: ActionId) => (a === "connect" || a === "retry" ? "primary" : a === "disconnect" || a === "cancel" ? "secondary" : "primary");

  return (
    <section className={s.statusCard} data-tone={view.tone} aria-labelledby="status-headline">
      <div className={s.ring} aria-hidden>
        <svg className={s.track} viewBox="0 0 148 148">
          <circle cx="74" cy="74" r="70" fill="none" stroke="currentColor" strokeOpacity="0.14" strokeWidth="3" />
          {view.protected ? <circle className={s.protectedArc} cx="74" cy="74" r="70" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /> : null}
        </svg>
        {view.busy ? (
          <svg className={`${s.spinArc} motion-loop`} viewBox="0 0 148 148">
            <circle cx="74" cy="74" r="70" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="80 360" />
          </svg>
        ) : null}
        {view.protected ? <span className={`${s.pulse} motion-loop`} /> : null}
        <span className={s.ringIcon}>
          {/* Keyed by tone: a new state's icon pops in. */}
          <Icon key={view.tone} size={40} strokeWidth={1.75} />
        </span>
      </div>

      <div className={s.statusText}>
        <h1 id="status-headline" className={s.headline} aria-live="polite">
          <span key={view.title} className={s.swap}>
            {t(view.title, view.values)}
          </span>
        </h1>
        <p className={s.detail}>
          {/* Keyed by message, not values: a ticking countdown doesn't re-animate. */}
          <span key={view.detail} className={s.swap}>
            {t(view.detail, { ...view.values, error: view.values.error ? t(`errors.${view.values.error}.title`) : "" })}
          </span>
        </p>
        {view.blocking || tunnel?.state === "error" ? (
          <div className={s.meta}>
            {view.blocking ? (
              <Badge tone="warning" dot>
                {t("status.trafficBlocked")}
              </Badge>
            ) : null}
            {tunnel?.state === "error" && tunnel.error.detail ? <Badge tone="outline" title={tunnel.error.detail}>{tunnel.error.kind}</Badge> : null}
          </div>
        ) : null}
        <div className={s.actions}>
          {view.primary ? (
            <Button
              size="lg"
              className={s.primary}
              variant={buttonVariant(view.primary)}
              icon={<Power size={18} />}
              onClick={() => void run(view.primary!)}
              aria-describedby="status-headline"
            >
              <span key={view.primary} className={s.swap}>
                {t(`actions.${view.primary}`)}
              </span>
            </Button>
          ) : null}
          {view.secondary.map((a) => (
            <Button key={a} size="lg" variant={a === "unblock" ? "danger" : "ghost"} onClick={() => void run(a)}>
              {t(`actions.${a}`)}
            </Button>
          ))}
        </div>
      </div>
    </section>
  );
}
