import { useTranslation } from "react-i18next";
import { connect } from "@/app/actions";
import { Badge, Button, Dialog, Flag, KeyValue, Latency, LoadMeter } from "@/design";
import { isAvailable, type ServerView } from "@/features/servers/model";
import { relativeTime } from "@/lib/format";
import { protocolsOf } from "./ServerRow";

export function ServerInfoDialog({ view, onClose }: { view: ServerView | null; onClose(): void }) {
  const { t, i18n } = useTranslation();
  if (!view) return null;
  const { server, location } = view;
  const health = server.health;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Flag code={location.countryCode} size={26} title={location.country} />
          {location.city}, {location.country}
        </span>
      }
      description={t("servers.info.title")}
      footer={
        <Button
          variant="primary"
          disabled={!isAvailable(view)}
          onClick={() => {
            onClose();
            void connect({ kind: "server", id: server.id });
          }}
        >
          {t("actions.connectHere")}
        </Button>
      }
    >
      <KeyValue
        items={[
          { label: t("servers.info.hostname"), value: <span className="mono">{server.hostname}</span> },
          { label: t("servers.info.address"), value: <span className="mono">{server.ipv4}{server.ipv6 ? ` · ${server.ipv6}` : ""}</span> },
          { label: t("servers.columns.status"), value: <Badge tone={server.status === "online" ? "success" : server.status === "busy" ? "warning" : "neutral"}>{t(`serverStatus.${server.status}`)}</Badge> },
          { label: t("servers.columns.latency"), value: <Latency ms={view.latency} /> },
          { label: t("servers.columns.load"), value: <LoadMeter load={server.load} /> },
          { label: t("servers.info.capacity"), value: server.capacity },
          { label: t("servers.info.protocols"), value: protocolsOf(view).join(", ") || "—" },
          { label: t("servers.info.features"), value: server.features.length ? server.features.map((f) => t(`features.${f}`)).join(", ") : "—" },
          {
            label: t("servers.info.health"),
            value: health ? t("servers.info.healthMeasured", { time: relativeTime(health.measuredAt, Date.now(), i18n.language) }) : t("servers.info.noHealth"),
          },
        ]}
      />
    </Dialog>
  );
}
