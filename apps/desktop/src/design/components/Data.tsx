import * as Flags from "country-flag-icons/react/3x2";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { useTranslation } from "react-i18next";
import { latency as fmtLatency, latencyTone, loadTone } from "@/lib/format";
import s from "./Data.module.css";

export function KeyValue({ items }: { items: { label: ReactNode; value: ReactNode; key?: string }[] }) {
  return (
    <dl className={s.kv}>
      {items.map((it, i) => (
        <div key={it.key ?? i} style={{ display: "contents" }}>
          <dt>{it.label}</dt>
          <dd>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Table({ head, children, label }: { head: ReactNode[]; children: ReactNode; label: string }) {
  return (
    <table className={s.table} aria-label={label}>
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={i} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/** Server load. `null` (no fresh measurement) renders as unknown, never as 0. */
export function LoadMeter({ load }: { load: number | null }) {
  const { t } = useTranslation();
  if (load === null) {
    return (
      <span className={s.meter} title={t("common.notMeasured")}>
        —
      </span>
    );
  }
  return (
    <span className={s.meter} aria-label={`${t("servers.columns.load")}: ${load}%`}>
      <span className={s.meterTrack} aria-hidden>
        <span className={s.meterFill} style={{ width: `${load}%` }} data-tone={loadTone(load)} />
      </span>
      <span className="tabular">{load}%</span>
    </span>
  );
}

/** Latency measured from this device. `null` = not measured / no answer. */
export function Latency({ ms }: { ms: number | null | undefined }) {
  const { t } = useTranslation();
  const tone = latencyTone(ms);
  return (
    <span className={s.latency} title={ms == null ? t("common.notMeasured") : t("dashboard.quality.measuredHere")}>
      <span className={s.bars} data-tone={tone} aria-hidden>
        <span />
        <span />
        <span />
      </span>
      {fmtLatency(ms)}
    </span>
  );
}

const FLAG_SET = Flags as unknown as Record<string, ComponentType<SVGProps<SVGSVGElement>>>;

export function Flag({ code, size = 20, title }: { code: string; size?: number; title?: string }) {
  const Svg = FLAG_SET[code.toUpperCase()];
  const style = { width: size, height: Math.round((size * 2) / 3) };
  if (!Svg) {
    return (
      <span className={`${s.flag} ${s.flagFallback}`} style={style} role="img" aria-label={title ?? code}>
        {code.toUpperCase()}
      </span>
    );
  }
  return (
    <span className={s.flag} style={style} role="img" aria-label={title ?? code}>
      <Svg aria-hidden />
    </span>
  );
}

/** Tiny area chart of recent values (e.g. throughput). */
export function Sparkline({ values, height = 36, color = "var(--accent)", label }: { values: number[]; height?: number; color?: string; label: string }) {
  const width = 160;
  if (values.length < 2) {
    return <svg className={s.sparkline} viewBox={`0 0 ${width} ${height}`} height={height} role="img" aria-label={label} />;
  }
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const points = values.map((v, i) => [i * step, height - (v / max) * (height - 4) - 2] as const);
  const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const gid = `spark-${label.replace(/\W/g, "")}`;
  return (
    <svg className={s.sparkline} viewBox={`0 0 ${width} ${height}`} height={height} preserveAspectRatio="none" role="img" aria-label={label}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
