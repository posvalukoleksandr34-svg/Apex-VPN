import { ChevronRight, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Button, Card, Flag, Latency, LoadMeter } from "@/design";
import { views } from "@/features/servers/model";
import type { ConnectTarget, RelaySummary } from "@/protocol";
import { useApp } from "@/state/store";
import s from "./Dashboard.module.css";

/** What we're connected to, or what "Connect" will use. */
export function LocationPanel() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tunnel = useApp((st) => st.tunnel);
  const settings = useApp((st) => st.settings);
  const relays = useApp((st) => st.relays);
  const latencies = useApp((st) => st.latencies);

  const relay: RelaySummary | null =
    tunnel?.state === "connected" ? tunnel.details.relay : tunnel && (tunnel.state === "connecting" || tunnel.state === "reconnecting") ? tunnel.relay : null;
  const target: ConnectTarget | null = settings?.defaultTarget ?? null;
  const server = relay ? views(relays, latencies).find((v) => v.server.id === relay.serverId) : target?.kind === "server" ? views(relays, latencies).find((v) => v.server.id === target.id) : undefined;

  return (
    <Card className={s.locationCard} title={t("dashboard.location")}>
      <div className={s.locationMain}>
        {relay ? (
          <Flag code={relay.countryCode} size={40} title={relay.country} />
        ) : server ? (
          <Flag code={server.location.countryCode} size={40} title={server.location.country} />
        ) : (
          <span className={s.smartIcon} aria-hidden>
            <Sparkles size={16} />
          </span>
        )}
        <div style={{ minWidth: 0 }}>
          <div className={s.locationName}>
            {relay ? `${relay.city}, ${relay.country}` : server ? `${server.location.city}, ${server.location.country}` : target?.kind === "smart" ? t(`smart.${target.mode}`) : t("dashboard.noServer")}
          </div>
          <div className={s.locationSub}>
            {relay ? relay.hostname : server ? server.server.hostname : target?.kind === "smart" ? t("dashboard.smartLocation", { mode: t(`smart.${target.mode}`) }) : null}
          </div>
        </div>
      </div>
      {server ? (
        <div className={s.locationStats}>
          <div>
            <div className={s.statLabel}>{t("dashboard.quality.latency")}</div>
            <Latency ms={server.latency} />
          </div>
          <div>
            <div className={s.statLabel}>{t("dashboard.quality.load")}</div>
            <LoadMeter load={server.server.load} />
          </div>
        </div>
      ) : null}
      <Button variant="secondary" onClick={() => navigate("/servers")} icon={<ChevronRight size={16} />}>
        {t("dashboard.changeLocation")}
      </Button>
    </Card>
  );
}
