import { BellOff, Check } from "lucide-react";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { transport } from "@/app/transportRef";
import { Button, EmptyState, Popover } from "@/design";
import { relativeTime } from "@/lib/format";
import { useApp, type AppNotification } from "@/state/store";

interface ApiNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

export function NotificationsPanel({ trigger }: { trigger: ReactElement }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const items = useApp((s) => s.notifications);
  const signedIn = useApp((s) => s.account.status === "signed_in");

  const load = async () => {
    if (!signedIn) return;
    try {
      const remote = await transport().account.request<ApiNotification[]>("GET", "/v1/notifications");
      const merged: AppNotification[] = [
        ...remote.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, createdAt: Date.parse(n.createdAt), read: !!n.readAt, source: "account" as const })),
        ...useApp.getState().notifications.filter((n) => n.source === "local"),
      ].sort((a, b) => b.createdAt - a.createdAt);
      useApp.setState({ notifications: merged.slice(0, 200) });
    } catch {
      /* keep what we have */
    }
  };

  const markAll = async () => {
    useApp.setState((s) => ({ notifications: s.notifications.map((n) => ({ ...n, read: true })) }));
    if (signedIn) await transport().account.request("POST", "/v1/notifications/read-all").catch(() => {});
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) void load();
      }}
      trigger={trigger}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-3)" }}>
        <h2 style={{ fontSize: "var(--text-lg)" }}>{t("notificationsPanel.title")}</h2>
        {items.some((n) => !n.read) ? (
          <Button size="sm" variant="ghost" icon={<Check size={14} />} onClick={markAll}>
            {t("notificationsPanel.markAll")}
          </Button>
        ) : null}
      </div>
      {items.length === 0 ? (
        <EmptyState icon={<BellOff size={22} />} title={t("notificationsPanel.empty.title")} body={t("notificationsPanel.empty.body")} />
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 380, overflowY: "auto", display: "grid", gap: 2 }}>
          {items.slice(0, 50).map((n) => (
            <li key={n.id} style={{ padding: "var(--space-3)", borderRadius: "var(--radius-sm)", background: n.read ? "transparent" : "var(--surface-3)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong style={{ fontWeight: 600 }}>{n.title}</strong>
                <span style={{ color: "var(--text-subtle)", fontSize: "var(--text-xs)", whiteSpace: "nowrap" }}>{relativeTime(n.createdAt, Date.now(), i18n.language)}</span>
              </div>
              <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{n.body}</div>
            </li>
          ))}
        </ul>
      )}
      <div style={{ marginTop: "var(--space-3)", textAlign: "right" }}>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            navigate("/settings/notifications");
          }}
        >
          {t("notificationsPanel.preferences")}
        </Button>
      </div>
    </Popover>
  );
}
