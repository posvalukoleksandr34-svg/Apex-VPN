/** Formatting helpers. Locale-aware where it matters; never invents values. */

export const DASH = "—";

export function bytes(n: number, locale?: string): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 }).format(v)} ${units[i]}`;
}

/** Bits per second, as network speeds are quoted. */
export function rate(bytesPerSecond: number | null, locale?: string): string {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond)) return DASH;
  const bits = bytesPerSecond * 8;
  const units = ["bps", "Kbps", "Mbps", "Gbps"];
  let v = bits;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 }).format(v)} ${units[i]}`;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x: number) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function latency(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? DASH : `${ms} ms`;
}

export function relativeTime(at: number, now = Date.now(), locale?: string): string {
  const diff = at - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < 45_000) return rtf.format(Math.round(diff / 1000), "second");
  if (abs < 45 * 60_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 22 * 3_600_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  return rtf.format(Math.round(diff / 86_400_000), "day");
}

export function dateTime(at: number | string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(at));
}

export function date(at: number | string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(at));
}

export function money(cents: number, currency: string, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

/** Quality bucket for a measured latency (UI colouring only). */
export function latencyTone(ms: number | null | undefined): "good" | "ok" | "poor" | "unknown" {
  if (ms === null || ms === undefined) return "unknown";
  if (ms < 60) return "good";
  if (ms < 150) return "ok";
  return "poor";
}

export function loadTone(load: number | null | undefined): "good" | "ok" | "poor" | "unknown" {
  if (load === null || load === undefined) return "unknown";
  if (load < 50) return "good";
  if (load < 80) return "ok";
  return "poor";
}
