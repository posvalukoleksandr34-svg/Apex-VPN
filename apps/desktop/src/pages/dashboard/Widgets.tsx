import { ArrowDown, ArrowUp, Clock, Gauge, Globe, KeyRound, MapPin, Navigation, Shield, ShieldCheck, Star, Zap } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { checkIp, connect } from "@/app/actions";
import { Badge, Button, Card, Flag, Latency, LoadMeter, Sparkline } from "@/design";
import { smartTarget, views } from "@/features/servers/model";
import { bytes, duration, rate, relativeTime } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import type { ConnectTarget } from "@/protocol";
import { useApp } from "@/state/store";
import s from "./Dashboard.module.css";

export function IpWidget() {
  const { t, i18n } = useTranslation();
  const ip = useApp((st) => st.ip);
  const connected = useApp((st) => st.tunnel?.state === "connected");
  const [busy, setBusy] = useState(false);
  const own = ip?.unprotected;
  // Only claim a VPN address that was actually observed through the tunnel.
  const vpn = connected && ip?.protected?.viaTunnel ? ip.protected : null;
  return (
    <Card title={t("dashboard.widgets.ip")} icon={<Globe size={15} />}>
      <div className={s.ipRow}>
        <span className={s.muted}>{t("dashboard.ip.yours")}</span>
        <span className={`${s.bigValue} mono`}>{own ? own.ip : "—"}</span>
        <span className={s.muted}>{own ? t("dashboard.ip.checkedWithout", { time: relativeTime(own.observedAt, Date.now(), i18n.language) }) : t("dashboard.ip.notChecked")}</span>
      </div>
      <div className={s.ipRow}>
        <span className={s.muted}>{t("dashboard.ip.vpn")}</span>
        <span className={`${s.bigValue} mono`}>{vpn ? vpn.ip : "—"}</span>
        {vpn ? (
          <Badge tone="success">{t("dashboard.ip.checkedThrough", { time: relativeTime(vpn.observedAt, Date.now(), i18n.language) })}</Badge>
        ) : (
          <span className={s.muted}>{t("dashboard.ip.notChecked")}</span>
        )}
      </div>
      <Button
        size="sm"
        variant="ghost"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          await checkIp().catch(() => {});
          setBusy(false);
        }}
      >
        {t("dashboard.ip.check")}
      </Button>
    </Card>
  );
}

export function QualityWidget() {
  const { t } = useTranslation();
  const tunnel = useApp((st) => st.tunnel);
  const relays = useApp((st) => st.relays);
  const latencies = useApp((st) => st.latencies);
  const settings = useApp((st) => st.settings);
  const id =
    tunnel?.state === "connected"
      ? tunnel.details.relay.serverId
      : settings?.defaultTarget.kind === "server"
        ? settings.defaultTarget.id
        : settings?.lastTarget?.kind === "server"
          ? settings.lastTarget.id
          : null;
  const v = id ? views(relays, latencies).find((x) => x.server.id === id) : undefined;
  return (
    <Card title={t("dashboard.widgets.quality")} icon={<Gauge size={15} />}>
      {v ? (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          <div className={s.fact}>
            <span className={s.muted}>{t("dashboard.quality.latency")}</span>
            <Latency ms={v.latency} />
          </div>
          <div className={s.fact}>
            <span className={s.muted}>{t("dashboard.quality.load")}</span>
            <LoadMeter load={v.server.load} />
          </div>
          <div className={s.fact}>
            <span className={s.muted}>{v.server.hostname}</span>
            <Badge tone={v.server.status === "online" ? "success" : v.server.status === "busy" ? "warning" : "neutral"}>{t(`serverStatus.${v.server.status}`)}</Badge>
          </div>
          <span className={s.muted}>{v.latency === null ? t("dashboard.quality.notMeasured") : t("dashboard.quality.measuredHere")}</span>
        </div>
      ) : (
        <p className={s.muted}>{t("dashboard.quality.notMeasured")}</p>
      )}
    </Card>
  );
}

export function SessionWidget() {
  const { t, i18n } = useTranslation();
  const tunnel = useApp((st) => st.tunnel);
  const rates = useApp((st) => st.rates);
  const stats = useApp((st) => st.stats);
  const connected = tunnel?.state === "connected";
  const now = useNow(1000, connected);
  return (
    <Card title={t("dashboard.widgets.session")} icon={<Clock size={15} />} className={s.wide}>
      {connected ? (
        <>
          <div className={s.bigValue}>{duration(now - tunnel.details.connectedAt)}</div>
          <div className={s.speeds}>
            <div className={s.speed}>
              <ArrowDown size={16} aria-hidden />
              <div>
                <div className={s.muted}>{t("dashboard.session.down")}</div>
                <div className="tabular">{rate(rates.rx, i18n.language)}</div>
              </div>
            </div>
            <div className={s.speed}>
              <ArrowUp size={16} aria-hidden />
              <div>
                <div className={s.muted}>{t("dashboard.session.up")}</div>
                <div className="tabular">{rate(rates.tx, i18n.language)}</div>
              </div>
            </div>
          </div>
          <Sparkline values={rates.history.map((h) => h.rx)} label={t("dashboard.session.down")} color="var(--status-success)" />
          {stats ? <div className={s.muted}>{t("dashboard.session.total", { down: bytes(stats.rxBytes, i18n.language), up: bytes(stats.txBytes, i18n.language) })}</div> : null}
        </>
      ) : (
        <p className={s.muted}>{t("dashboard.session.idle")}</p>
      )}
    </Card>
  );
}

export function ProtocolWidget() {
  const { t } = useTranslation();
  const tunnel = useApp((st) => st.tunnel);
  const pref = useApp((st) => st.settings?.protocol);
  const connected = tunnel?.state === "connected" ? tunnel.details : null;
  return (
    <Card title={t("dashboard.widgets.protocol")} icon={<KeyRound size={15} />}>
      <div className={s.bigValue}>{connected ? t(`settings.protocols.${connected.relay.protocol}.name`) : pref ? t(pref === "automatic" ? "dashboard.protocol.automatic" : `settings.protocols.${pref}.name`) : "—"}</div>
      <div className={s.muted} style={{ marginTop: "var(--space-2)" }}>
        {t("dashboard.protocol.cipher")}: {connected ? connected.cipher.data : "—"}
      </div>
      {connected ? <div className={`${s.muted} mono`}>{connected.cipher.keyExchange}</div> : null}
    </Card>
  );
}

export function SecurityWidget() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tunnel = useApp((st) => st.tunnel);
  const p = tunnel?.state === "connected" ? tunnel.details.protections : null;
  const row = (label: string, ok: boolean | null, text: string) => (
    <li className={s.fact}>
      <span className={s.muted}>{label}</span>
      <Badge tone={ok ? "success" : "neutral"} dot>
        {text}
      </Badge>
    </li>
  );
  return (
    <Card
      title={t("dashboard.widgets.security")}
      icon={<ShieldCheck size={15} />}
      actions={
        <Button size="sm" variant="ghost" onClick={() => navigate("/security")}>
          {t("dashboard.security.seeAll")}
        </Button>
      }
    >
      <ul className={s.factList}>
        {row(t("dashboard.security.killSwitch"), p?.killSwitch ?? null, p?.killSwitch ? t("dashboard.security.active") : t("dashboard.security.inactive"))}
        {row(t("dashboard.security.dns"), p?.dnsLeakBlocking ?? null, p?.dnsLeakBlocking ? t("dashboard.security.active") : t("dashboard.security.inactive"))}
        {row(
          t("dashboard.security.ipv6"),
          p ? p.ipv6Tunneled || p.ipv6LeakBlocking : null,
          !p ? t("dashboard.security.inactive") : p.ipv6Tunneled ? t("dashboard.security.ipv6Tunneled") : p.ipv6LeakBlocking ? t("dashboard.security.ipv6Blocked") : t("dashboard.security.ipv6Open"),
        )}
      </ul>
    </Card>
  );
}

export function QuickActions() {
  const { t } = useTranslation();
  const settings = useApp((st) => st.settings);
  const favorites = useApp((st) => st.prefs.favorites);
  const relays = useApp((st) => st.relays);
  const lastTarget = settings?.lastTarget ?? null;
  const favorite = favorites[0];
  const favoriteTarget: ConnectTarget | null = favorite
    ? favorite.startsWith("loc:")
      ? (() => {
          const loc = relays?.locations.find((l) => l.id === favorite.slice(4));
          return loc ? smartTarget("best_overall", loc.countryCode, loc.city) : null;
        })()
      : { kind: "server", id: favorite }
    : null;
  const lastLabel = lastTarget?.kind === "server" ? lastTarget.id : null;

  const items: { key: string; icon: ReactNode; label: string; sub: string; target: ConnectTarget | null }[] = [
    { key: "fastest", icon: <Zap size={18} />, label: t("dashboard.quick.fastest"), sub: t("smart.desc.fastest"), target: smartTarget("fastest") },
    { key: "nearest", icon: <Navigation size={18} />, label: t("dashboard.quick.nearest"), sub: t("smart.desc.nearest"), target: smartTarget("nearest") },
    { key: "last", icon: <Clock size={18} />, label: t("dashboard.quick.lastUsed"), sub: lastLabel ?? t("dashboard.quick.noLastUsed"), target: lastTarget },
    { key: "favorite", icon: <Star size={18} />, label: t("dashboard.quick.favorite"), sub: favorite ?? t("dashboard.quick.noFavorite"), target: favoriteTarget },
    { key: "secure", icon: <Shield size={18} />, label: t("dashboard.quick.secure"), sub: t("features.privacy"), target: smartTarget("best_overall", undefined, undefined, ["privacy"]) },
  ];
  return (
    <Card title={t("dashboard.widgets.quickActions")} icon={<Zap size={15} />} className={s.wide}>
      <div className={s.quickGrid}>
        {items.map((it) => (
          <button key={it.key} type="button" className={s.quick} title={it.sub} disabled={!it.target} onClick={() => it.target && void connect(it.target)}>
            {it.icon}
            <span className={s.quickLabel}>{it.label}</span>
            <span className={s.quickSub}>{it.sub}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

export function RecentLocations() {
  const { t, i18n } = useTranslation();
  const recents = useApp((st) => st.prefs.recents);
  const relays = useApp((st) => st.relays);
  const latencies = useApp((st) => st.latencies);
  const all = views(relays, latencies);
  const items = recents.flatMap((r) => {
    const v = all.find((x) => x.server.id === r.serverId);
    return v ? [{ ...v, at: r.at }] : [];
  });
  return (
    <Card title={t("dashboard.widgets.recent")} icon={<MapPin size={15} />}>
      {items.length === 0 ? (
        <p className={s.muted}>{t("dashboard.recentEmpty")}</p>
      ) : (
        <ul className={s.recentList}>
          {items.slice(0, 5).map((v) => (
            <li key={v.server.id} className={s.recentItem}>
              <Flag code={v.location.countryCode} size={22} title={v.location.country} />
              <div className={s.recentName}>
                <div>{v.location.city}</div>
                <div className={s.muted}>{relativeTime(v.at, Date.now(), i18n.language)}</div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void connect({ kind: "server", id: v.server.id })} aria-label={`${t("actions.connect")} ${v.location.city}`}>
                {t("actions.connect")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
