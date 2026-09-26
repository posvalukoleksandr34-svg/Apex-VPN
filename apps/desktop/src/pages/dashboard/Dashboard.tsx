import { ArrowDown, ArrowUp, SlidersHorizontal } from "lucide-react";
import { useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, IconButton, Page, Switch } from "@/design";
import { useApp } from "@/state/store";
import { DEFAULT_PREFS, type WidgetId } from "@/state/types";
import s from "./Dashboard.module.css";
import { LocationPanel } from "./LocationPanel";
import { StatusHero } from "./StatusHero";
import { IpWidget, ProtocolWidget, QualityWidget, QuickActions, RecentLocations, SecurityWidget, SessionWidget } from "./Widgets";

const WIDGETS: Record<WidgetId, ComponentType> = {
  ip: IpWidget,
  quality: QualityWidget,
  session: SessionWidget,
  protocol: ProtocolWidget,
  security: SecurityWidget,
  quickActions: QuickActions,
  recent: RecentLocations,
};

export function Dashboard() {
  const { t } = useTranslation();
  const widgets = useApp((st) => st.prefs.widgets);
  const [customizing, setCustomizing] = useState(false);

  return (
    <Page>
      <h1 className="sr-only">{t("dashboard.title")}</h1>
      <div className={s.hero}>
        <StatusHero />
        <LocationPanel />
      </div>
      <div className={s.widgets}>
        {widgets.map((id) => {
          const W = WIDGETS[id];
          return W ? <W key={id} /> : null;
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "var(--space-4)" }}>
        <Button variant="ghost" size="sm" icon={<SlidersHorizontal size={14} />} onClick={() => setCustomizing(true)}>
          {t("dashboard.customize")}
        </Button>
      </div>
      <CustomizeDialog open={customizing} onOpenChange={setCustomizing} />
    </Page>
  );
}

function CustomizeDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const { t } = useTranslation();
  const widgets = useApp((st) => st.prefs.widgets);
  const setPrefs = useApp((st) => st.setPrefs);
  const all = [...widgets, ...DEFAULT_PREFS.widgets.filter((w) => !widgets.includes(w))];
  const move = (id: WidgetId, by: -1 | 1) => {
    const list = [...widgets];
    const i = list.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    setPrefs({ widgets: list });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("dashboard.customizeTitle")}
      description={t("dashboard.customizeHint")}
      footer={
        <>
          <Button variant="ghost" onClick={() => setPrefs({ widgets: DEFAULT_PREFS.widgets })}>
            {t("actions.reset")}
          </Button>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            {t("actions.done")}
          </Button>
        </>
      }
    >
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
        {all.map((id) => {
          const on = widgets.includes(id);
          const label = t(`dashboard.widgets.${id}`);
          return (
            <li key={id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
              <Switch label={label} checked={on} onCheckedChange={(v) => setPrefs({ widgets: v ? [...widgets, id] : widgets.filter((w) => w !== id) })} />
              <span style={{ flex: 1 }}>{label}</span>
              <IconButton size="sm" label={t("actions.moveUp")} icon={<ArrowUp size={14} />} disabled={!on} onClick={() => move(id, -1)} />
              <IconButton size="sm" label={t("actions.moveDown")} icon={<ArrowDown size={14} />} disabled={!on} onClick={() => move(id, 1)} />
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
