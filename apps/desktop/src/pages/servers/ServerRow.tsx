import { Info, Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import { connect, toggleFavorite } from "@/app/actions";
import { Badge, Button, Flag, IconButton, Latency, LoadMeter } from "@/design";
import { isAvailable, type ServerView } from "@/features/servers/model";
import { useApp } from "@/state/store";
import s from "./Servers.module.css";

export function protocolsOf(v: ServerView): string[] {
  return [v.server.wireguard ? "WG" : null, v.server.openvpn ? "OVPN" : null, v.server.ikev2 ? "IKEv2" : null].filter((x): x is string => !!x);
}

export function ServerRow({ view, showFlag, onInfo, extraActions }: { view: ServerView; showFlag?: boolean; onInfo(v: ServerView): void; extraActions?: React.ReactNode }) {
  const { t } = useTranslation();
  const favorite = useApp((st) => st.prefs.favorites.includes(view.server.id));
  const current = useApp((st) => st.tunnel?.state === "connected" && st.tunnel.details.relay.serverId === view.server.id);
  const available = isAvailable(view);
  const status = view.server.status;
  return (
    <li className={`${s.server} ${current ? s.current : ""}`}>
      <div className={s.serverName}>
        {showFlag ? <Flag code={view.location.countryCode} size={24} title={view.location.country} /> : null}
        <div>
          <div className={s.serverTitle}>{showFlag ? `${view.location.city}, ${view.location.country}` : view.server.id}</div>
          <div className={s.serverSub}>{view.server.hostname}</div>
        </div>
      </div>
      <Latency ms={view.latency} />
      <span className={s.hideNarrow}>
        <LoadMeter load={view.server.load} />
      </span>
      <div className={`${s.tags} ${s.hideNarrow}`}>
        {status !== "online" ? <Badge tone={status === "busy" ? "warning" : "neutral"}>{t(`serverStatus.${status}`)}</Badge> : null}
        {protocolsOf(view).map((p) => (
          <Badge key={p} tone="outline">
            {p}
          </Badge>
        ))}
        {view.server.features.map((f) => (
          <Badge key={f} tone="accent">
            {t(`features.${f}`)}
          </Badge>
        ))}
      </div>
      <div className={s.rowActions}>
        {extraActions}
        <IconButton
          size="sm"
          className={s.star}
          aria-pressed={favorite}
          label={t(favorite ? "actions.unfavorite" : "actions.favorite")}
          icon={<Star size={15} />}
          onClick={() => toggleFavorite(view.server.id)}
        />
        <IconButton size="sm" label={t("servers.info.title")} icon={<Info size={15} />} onClick={() => onInfo(view)} />
        <Button size="sm" variant={current ? "ghost" : "secondary"} disabled={!available || current} onClick={() => void connect({ kind: "server", id: view.server.id })}>
          {t("actions.connect")}
        </Button>
      </div>
    </li>
  );
}
