import { clsx } from "clsx";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import s from "./Layout.module.css";

export function Card({
  title,
  icon,
  actions,
  flush,
  interactive,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & { title?: ReactNode; icon?: ReactNode; actions?: ReactNode; flush?: boolean; interactive?: boolean }) {
  return (
    <section className={clsx(s.card, flush && s.flush, interactive && s.interactive, className)} {...rest}>
      {title || actions ? (
        <header className={s.cardHeader}>
          {title ? (
            <h3 className={s.cardTitle}>
              {icon}
              {title}
            </h3>
          ) : (
            <span />
          )}
          {actions}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx(s.page, className)}>{children}</div>;
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className={s.pageHeader}>
      <div>
        <h1 className={s.pageTitle}>{title}</h1>
        {subtitle ? <p className={s.pageSubtitle}>{subtitle}</p> : null}
      </div>
      {actions ? <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>{actions}</div> : null}
    </header>
  );
}

export function Section({ title, intro, children, id }: { title?: ReactNode; intro?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className={s.section} id={id}>
      {title ? <h2 className={s.sectionTitle}>{title}</h2> : null}
      {intro ? <p className={s.sectionIntro}>{intro}</p> : null}
      {children}
    </section>
  );
}

export function Stack({ gap = 3, children, style, className }: { gap?: number; children: ReactNode; style?: CSSProperties; className?: string }) {
  return (
    <div className={clsx(s.stack, className)} style={{ gap: `var(--space-${gap})`, ...style }}>
      {children}
    </div>
  );
}

export function Row({ gap = 2, children, style, wrap, justify, className }: { gap?: number; children: ReactNode; style?: CSSProperties; wrap?: boolean; justify?: CSSProperties["justifyContent"]; className?: string }) {
  return (
    <div className={clsx(s.row, className)} style={{ gap: `var(--space-${gap})`, flexWrap: wrap ? "wrap" : undefined, justifyContent: justify, ...style }}>
      {children}
    </div>
  );
}

export function Grid({ min = 240, children, style }: { min?: number; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className={s.grid} style={{ ["--min" as string]: `${min}px`, ...style }}>
      {children}
    </div>
  );
}
