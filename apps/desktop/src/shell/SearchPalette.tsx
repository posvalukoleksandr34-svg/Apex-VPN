import * as RDialog from "@radix-ui/react-dialog";
import { CircleQuestionMark, Layers, Power, Search, Server, Settings as SettingsIcon, Stethoscope } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { applyProfile, connect, disconnect } from "@/app/actions";
import { Flag, Kbd } from "@/design";
import { SETTINGS_SECTIONS } from "@/pages/settings/sections";
import { HELP_ARTICLES } from "@/pages/support/articles";
import { useApp } from "@/state/store";
import s from "./SearchPalette.module.css";

interface Result {
  id: string;
  group: "actions" | "servers" | "settings" | "profiles" | "help";
  label: string;
  hint?: string;
  icon: ReactNode;
  run(): void;
}

export function SearchPalette({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const relays = useApp((st) => st.relays);
  const profiles = useApp((st) => st.prefs.profiles);
  const tunnel = useApp((st) => st.tunnel);

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    const match = (...texts: (string | undefined)[]) => !q || texts.some((x) => x?.toLowerCase().includes(q));
    const go = (path: string) => () => navigate(path);
    const out: Result[] = [];
    const connected = tunnel && tunnel.state !== "disconnected";
    const actionLabel = t(connected ? "actions.disconnect" : "actions.connect");
    if (match(actionLabel)) out.push({ id: "toggle", group: "actions", label: actionLabel, icon: <Power size={16} />, run: () => void (connected ? disconnect() : connect()) });
    if (match(t("actions.runAll"), t("nav.diagnostics"))) out.push({ id: "diag", group: "actions", label: t("actions.runAll"), icon: <Stethoscope size={16} />, run: go("/diagnostics") });
    if (match(t("security.leaks.run"))) out.push({ id: "leak", group: "actions", label: t("security.leaks.run"), icon: <Stethoscope size={16} />, run: go("/security/leaks") });

    if (relays && q) {
      for (const loc of relays.locations) {
        if (!match(loc.country, loc.city, loc.countryCode)) continue;
        out.push({
          id: `loc-${loc.id}`,
          group: "servers",
          label: `${loc.city}, ${loc.country}`,
          hint: t("servers.smartIn", { place: loc.city }),
          icon: <Flag code={loc.countryCode} size={18} />,
          run: () => void connect({ kind: "smart", mode: "best_overall", country: loc.countryCode, city: loc.city, features: [] }),
        });
      }
      for (const sv of relays.servers) {
        if (!match(sv.id, sv.hostname)) continue;
        out.push({ id: `srv-${sv.id}`, group: "servers", label: sv.hostname, hint: sv.id, icon: <Server size={16} />, run: () => void connect({ kind: "server", id: sv.id }) });
      }
    }
    for (const sec of SETTINGS_SECTIONS) {
      const label = t(`settings.sections.${sec.id}`);
      if (match(label, ...sec.keywords)) out.push({ id: `set-${sec.id}`, group: "settings", label, icon: <SettingsIcon size={16} />, run: go(`/settings/${sec.id}`) });
    }
    for (const p of profiles) {
      if (match(p.name)) out.push({ id: `prof-${p.id}`, group: "profiles", label: p.name, icon: <Layers size={16} />, run: () => void applyProfile(p) });
    }
    for (const a of HELP_ARTICLES) {
      const title = t(`support.articles.${a}.title`);
      if (match(title, t(`support.articles.${a}.body`))) out.push({ id: `help-${a}`, group: "help", label: title, icon: <CircleQuestionMark size={16} />, run: go(`/support/help#${a}`) });
    }
    return out.slice(0, 40);
  }, [query, relays, profiles, tunnel, t, navigate]);

  const choose = (r: Result | undefined) => {
    if (!r) return;
    onOpenChange(false);
    setQuery("");
    r.run();
  };

  const groups = ["actions", "servers", "settings", "profiles", "help"] as const;

  return (
    <RDialog.Root
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setQuery("");
      }}
    >
      <RDialog.Portal>
        <RDialog.Overlay className={s.overlay} />
        <RDialog.Content className={s.palette} aria-describedby={undefined}>
          <RDialog.Title className="sr-only">{t("nav.search")}</RDialog.Title>
          <div className={s.inputRow}>
            <Search size={18} aria-hidden />
            <input
              className={s.input}
              autoFocus
              value={query}
              placeholder={t("search.placeholder")}
              aria-label={t("search.placeholder")}
              role="combobox"
              aria-expanded
              aria-controls="search-results"
              aria-activedescendant={results[active] ? `sr-${results[active].id}` : undefined}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(results.length - 1, a + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  choose(results[active]);
                }
              }}
            />
          </div>
          <div id="search-results" role="listbox" className={s.results}>
            {results.length === 0 ? <div className={s.empty}>{t("search.empty", { query })}</div> : null}
            {groups.map((g) => {
              const items = results.filter((r) => r.group === g);
              if (!items.length) return null;
              return (
                <div key={g} role="group" aria-label={t(`search.groups.${g}`)}>
                  <div className={s.groupLabel}>{t(`search.groups.${g}`)}</div>
                  {items.map((r) => {
                    const idx = results.indexOf(r);
                    return (
                      <div
                        key={r.id}
                        id={`sr-${r.id}`}
                        role="option"
                        aria-selected={idx === active}
                        className={s.item}
                        onMouseEnter={() => setActive(idx)}
                        onClick={() => choose(r)}
                      >
                        <span className={s.itemIcon}>{r.icon}</span>
                        <span className={s.itemLabel}>{r.label}</span>
                        {r.hint ? <span className={s.itemHint}>{r.hint}</span> : null}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          <div className={s.footer}>
            {t("search.hint")} <Kbd combo="Esc" />
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
