import { ArrowDown, ArrowUp, ChevronRight, Clock, Globe, RefreshCw, SearchX, Sparkles, Star } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { connect, measureLatencies, moveFavorite, toggleFavorite } from "@/app/actions";
import { Banner, Button, Card, EmptyState, Flag, IconButton, Latency, Menu, MenuItem, MenuLabel, Page, PageHeader, SearchField, Segmented, TabPanel, Tabs } from "@/design";
import {
  filterViews,
  groupByCountry,
  isAvailable,
  locationKey,
  smartTarget,
  sortViews,
  views,
  type FeatureFilter,
  type ServerView,
  type SortKey,
} from "@/features/servers/model";
import { relativeTime } from "@/lib/format";
import type { ServerFeature, SmartMode } from "@/protocol";
import { useApp } from "@/state/store";
import { ServerInfoDialog } from "./ServerInfoDialog";
import { ServerRow } from "./ServerRow";
import s from "./Servers.module.css";

const FEATURES: FeatureFilter[] = ["all", "streaming", "gaming", "privacy", "p2p", "low_latency"];
const MODES: SmartMode[] = ["best_overall", "fastest", "nearest", "lowest_load"];

export default function Servers() {
  const { t, i18n } = useTranslation();
  const relays = useApp((st) => st.relays);
  const relayStatus = useApp((st) => st.relayStatus);
  const latencies = useApp((st) => st.latencies);
  const favorites = useApp((st) => st.prefs.favorites);
  const recents = useApp((st) => st.prefs.recents);
  const [tab, setTab] = useState("recommended");
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const [feature, setFeature] = useState<FeatureFilter>("all");
  const [sort, setSort] = useState<SortKey>("best");
  const [info, setInfo] = useState<ServerView | null>(null);
  const [measuring, setMeasuring] = useState(false);

  const all = useMemo(() => views(relays, latencies), [relays, latencies]);
  const filtered = useMemo(() => sortViews(filterViews(all, deferred, feature), sort, i18n.language), [all, deferred, feature, sort, i18n.language]);

  const measure = async () => {
    setMeasuring(true);
    await measureLatencies().catch(() => {});
    setMeasuring(false);
  };

  const header = (
    <PageHeader
      title={t("servers.title")}
      actions={
        <>
          <Button variant="ghost" icon={<RefreshCw size={16} />} loading={measuring} onClick={measure} disabled={!relays}>
            {measuring ? t("servers.measuring") : t("servers.measure")}
          </Button>
          <Menu trigger={<Button variant="primary" icon={<Sparkles size={16} />}>{t("servers.smartConnect")}</Button>}>
            <MenuLabel>{t("servers.smartConnect")}</MenuLabel>
            {MODES.map((m) => (
              <MenuItem key={m} onSelect={() => void connect(smartTarget(m))}>
                <span>
                  <strong style={{ fontWeight: 500 }}>{t(`smart.${m}`)}</strong>
                  <br />
                  <span style={{ color: "var(--text-subtle)", fontSize: "var(--text-xs)" }}>{t(`smart.desc.${m}`)}</span>
                </span>
              </MenuItem>
            ))}
          </Menu>
        </>
      }
    />
  );

  if (!relays) {
    return (
      <Page>
        {header}
        <Card>
          <EmptyState icon={<Globe size={22} />} title={t("servers.noList.title")} body={t("servers.noList.body")} />
        </Card>
      </Page>
    );
  }

  const noResults = (
    <EmptyState icon={<SearchX size={22} />} title={t("servers.emptySearch.title")} body={t("servers.emptySearch.body", { query: deferred })} />
  );

  return (
    <Page>
      {header}
      <div className={s.toolbar}>
        <div className={s.search}>
          <SearchField label={t("servers.searchPlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Segmented<SortKey>
          label={t("servers.sort.label")}
          value={sort}
          onValueChange={setSort}
          options={(["best", "latency", "load", "name"] as SortKey[]).map((k) => ({ value: k, label: t(`servers.sort.${k}`) }))}
        />
      </div>
      <div className={s.chips} role="group" aria-label={t("servers.filters.label")}>
        {FEATURES.map((f) => (
          <button key={f} type="button" className={s.chip} aria-pressed={feature === f} onClick={() => setFeature(f)}>
            {f === "all" ? t("servers.filters.all") : t(`features.${f}`)}
          </button>
        ))}
      </div>
      <div className={s.meta}>
        <span>
          {relayStatus?.version != null ? t("servers.listAge", { version: relayStatus.version, time: relayStatus.fetchedAt ? relativeTime(relayStatus.fetchedAt, Date.now(), i18n.language) : "—" }) : null}
        </span>
        <span>{t("servers.latencyNote")}</span>
      </div>
      {relayStatus?.stale ? (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Banner tone="warning">{t("servers.stale")}</Banner>
        </div>
      ) : null}

      <Tabs label={t("servers.title")} value={tab} onValueChange={setTab} items={(["recommended", "favorites", "recent", "all"] as const).map((k) => ({ value: k, label: t(`servers.tabs.${k}`) }))}>

        <TabPanel value="recommended">
          {filtered.length === 0 ? (
            noResults
          ) : (
            <ul className={s.list}>
              {filtered.filter(isAvailable).slice(0, 10).map((v) => (
                <ServerRow key={v.server.id} view={v} showFlag onInfo={setInfo} />
              ))}
            </ul>
          )}
        </TabPanel>

        <TabPanel value="favorites">
          <Favorites all={all} favorites={favorites} onInfo={setInfo} />
        </TabPanel>

        <TabPanel value="recent">
          {recents.length === 0 ? (
            <EmptyState icon={<Clock size={22} />} title={t("servers.emptyRecent.title")} body={t("servers.emptyRecent.body")} />
          ) : (
            <ul className={s.list}>
              {recents.flatMap((r) => {
                const v = all.find((x) => x.server.id === r.serverId);
                return v ? [<ServerRow key={v.server.id} view={v} showFlag onInfo={setInfo} />] : [];
              })}
            </ul>
          )}
        </TabPanel>

        <TabPanel value="all">{filtered.length === 0 ? noResults : <AllLocations list={filtered} expandAll={!!deferred} onInfo={setInfo} />}</TabPanel>
      </Tabs>

      <ServerInfoDialog view={info} onClose={() => setInfo(null)} />
    </Page>
  );
}

function Favorites({ all, favorites, onInfo }: { all: ServerView[]; favorites: string[]; onInfo(v: ServerView): void }) {
  const { t } = useTranslation();
  const relays = useApp((st) => st.relays);
  if (favorites.length === 0) {
    return <EmptyState icon={<Star size={22} />} title={t("servers.emptyFavorites.title")} body={t("servers.emptyFavorites.body")} />;
  }
  const reorder = (id: string, i: number) => (
    <>
      <IconButton size="sm" label={t("actions.moveUp")} icon={<ArrowUp size={14} />} disabled={i === 0} onClick={() => moveFavorite(id, -1)} />
      <IconButton size="sm" label={t("actions.moveDown")} icon={<ArrowDown size={14} />} disabled={i === favorites.length - 1} onClick={() => moveFavorite(id, 1)} />
    </>
  );
  return (
    <ul className={s.list}>
      {favorites.map((id, i) => {
        if (id.startsWith("loc:")) {
          const loc = relays?.locations.find((l) => l.id === id.slice(4));
          if (!loc) return null;
          const best = all.filter((v) => v.location.id === loc.id && isAvailable(v)).sort((a, b) => (a.latency ?? 999) - (b.latency ?? 999))[0];
          return (
            <li key={id} className={s.server}>
              <div className={s.serverName}>
                <Flag code={loc.countryCode} size={24} title={loc.country} />
                <div>
                  <div className={s.serverTitle}>
                    {loc.city}, {loc.country}
                  </div>
                  <div className={s.serverSub}>{t("servers.smartIn", { place: loc.city })}</div>
                </div>
              </div>
              <Latency ms={best?.latency ?? null} />
              <span className={s.hideNarrow} />
              <span className={s.hideNarrow} />
              <div className={s.rowActions}>
                {reorder(id, i)}
                <IconButton size="sm" label={t("actions.unfavorite")} icon={<Star size={15} fill="currentColor" color="var(--status-warning)" />} onClick={() => toggleFavorite(id)} />
                <Button size="sm" disabled={!best} onClick={() => void connect(smartTarget("best_overall", loc.countryCode, loc.city))}>
                  {t("actions.connect")}
                </Button>
              </div>
            </li>
          );
        }
        const v = all.find((x) => x.server.id === id);
        return v ? <ServerRow key={id} view={v} showFlag onInfo={onInfo} extraActions={reorder(id, i)} /> : null;
      })}
    </ul>
  );
}

function AllLocations({ list, expandAll, onInfo }: { list: ServerView[]; expandAll: boolean; onInfo(v: ServerView): void }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const favorites = useApp((st) => st.prefs.favorites);
  const groups = groupByCountry(list, i18n.language);
  const toggle = (cc: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(cc)) next.delete(cc);
      else next.add(cc);
      return next;
    });
  return (
    <ul className={s.list}>
      {groups.map((g) => {
        const expanded = expandAll || open.has(g.countryCode);
        return (
          <li key={g.countryCode} className={s.country}>
            <div
              className={s.countryRow}
              role="button"
              tabIndex={0}
              aria-expanded={expanded}
              onClick={() => toggle(g.countryCode)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle(g.countryCode))}
            >
              <ChevronRight size={16} className={s.chevron} aria-hidden />
              <Flag code={g.countryCode} size={24} title={g.country} />
              <span className={s.countryName}>{g.country}</span>
              <span className={s.countryMeta}>{t("servers.count", { count: g.servers.length })}</span>
              <Latency ms={g.bestLatency} />
              <Button
                size="sm"
                disabled={!g.available}
                onClick={(e) => {
                  e.stopPropagation();
                  void connect(smartTarget("best_overall", g.countryCode));
                }}
              >
                {t("actions.connect")}
              </Button>
            </div>
            {expanded ? (
              <div className={s.cityBlock}>
                {g.cities.map((c) => {
                  const fav = favorites.includes(locationKey(c.location.id));
                  const features = [...new Set(c.servers.flatMap((v) => v.server.features))] as ServerFeature[];
                  return (
                    <div key={c.location.id}>
                      <div className={s.cityTitle}>
                        <span style={{ flex: 1 }}>{c.location.city}</span>
                        {features.slice(0, 3).map((f) => (
                          <span key={f} style={{ fontSize: "var(--text-xs)" }}>
                            {t(`features.${f}`)}
                          </span>
                        ))}
                        <IconButton
                          size="sm"
                          aria-pressed={fav}
                          label={t(fav ? "actions.unfavorite" : "actions.favorite")}
                          icon={<Star size={14} fill={fav ? "currentColor" : "none"} color={fav ? "var(--status-warning)" : undefined} />}
                          onClick={() => toggleFavorite(locationKey(c.location.id))}
                        />
                        <Button size="sm" variant="ghost" onClick={() => void connect(smartTarget("best_overall", c.location.countryCode, c.location.city))}>
                          {t("servers.smartIn", { place: c.location.city })}
                        </Button>
                      </div>
                      <ul className={s.list}>
                        {c.servers.map((v) => (
                          <ServerRow key={v.server.id} view={v} onInfo={onInfo} />
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
