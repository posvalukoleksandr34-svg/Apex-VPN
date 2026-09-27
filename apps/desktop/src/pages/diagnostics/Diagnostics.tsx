import { Copy, Download, LifeBuoy, Play, ScrollText, Trash } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { transport } from "@/app/transportRef";
import { Badge, Banner, Button, Card, EmptyState, Page, PageHeader, SearchField, Select, Switch, TabPanel, Tabs, useConfirm, useToast } from "@/design";
import { authenticationCheck, reportText } from "@/features/diagnostics/report";
import { relativeTime } from "@/lib/format";
import type { CheckId, CheckResult, LogCategory, LogLevel } from "@/protocol";
import { useApp } from "@/state/store";
import s from "./Diagnostics.module.css";

const ORDER: CheckId[] = ["internet", "dns", "service", "authentication", "server_reachability", "tunnel", "routing", "kill_switch", "ipv6"];
const MARK: Record<CheckResult["status"], string> = { working: "✓", warning: "⚠", failed: "✕", skipped: "–" };

/** Last results survive navigating away (not app restarts). */
let lastRun: { at: number; checks: CheckResult[] } | null = null;

export default function Diagnostics() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { tab = "checks" } = useParams<{ tab: "checks" | "logs" }>();
  return (
    <Page>
      <PageHeader title={t("diagnostics.title")} />
      <Tabs label={t("diagnostics.title")} value={tab} onValueChange={(v) => navigate(`/diagnostics/${v}`)} items={(["checks", "logs"] as const).map((k) => ({ value: k, label: t(`diagnostics.tabs.${k}`) }))}>
        <TabPanel value="checks">
          <Checks />
        </TabPanel>
        <TabPanel value="logs">
          <Logs />
        </TabPanel>
      </Tabs>
    </Page>
  );
}

function Checks() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const service = useApp((st) => st.service);
  const [run, setRun] = useState(lastRun);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Set<CheckId>>(new Set());

  const runAll = async () => {
    setBusy(true);
    try {
      const state = useApp.getState();
      const [serviceChecks, auth] = await Promise.all([
        state.service === "ready" ? transport().call("run_diagnostics", { checks: null }).catch(() => [] as CheckResult[]) : Promise.resolve([] as CheckResult[]),
        authenticationCheck(state),
      ]);
      const all = [...serviceChecks, auth];
      if (state.service !== "ready") {
        all.push({ id: "service", status: "failed", finding: "service_unreachable", evidence: {}, durationMs: 0 });
      }
      const sorted = ORDER.flatMap((id) => all.filter((c) => c.id === id));
      lastRun = { at: Date.now(), checks: sorted };
      setRun(lastRun);
      setOpen(new Set(sorted.filter((c) => c.status === "failed" || c.status === "warning").map((c) => c.id)));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: CheckId) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <p className={s.intro}>{t("diagnostics.intro")}</p>
      <div className={s.toolbar}>
        <Button variant="primary" icon={<Play size={16} />} loading={busy} onClick={runAll}>
          {run ? t("actions.runAgain") : t("actions.runAll")}
        </Button>
        {run ? (
          <>
            <Button
              icon={<Copy size={16} />}
              onClick={async () => {
                await navigator.clipboard.writeText(reportText(run.checks, useApp.getState(), t));
                toast({ tone: "success", title: t("actions.copied") });
              }}
            >
              {t("diagnostics.copyReport")}
            </Button>
            <Button icon={<LifeBuoy size={16} />} onClick={() => navigate("/support/contact?report=1")}>
              {t("diagnostics.sendReport")}
            </Button>
          </>
        ) : null}
        <span className={s.meta}>{run ? t("diagnostics.lastRun", { time: relativeTime(run.at, Date.now(), i18n.language) }) : t("diagnostics.notRun")}</span>
      </div>
      {service === "unavailable" ? (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Banner tone="error">{t("status.serviceUnavailable.detail")}</Banner>
        </div>
      ) : null}
      <Card flush>
        <ul className={s.checks}>
          {(run?.checks ?? ORDER.map((id): CheckResult => ({ id, status: "skipped", finding: "", evidence: {}, durationMs: 0 }))).map((c) => {
            const expandable = !!run && (c.status === "failed" || c.status === "warning");
            const f = `diagnostics.findings.${c.finding}`;
            const Row = expandable ? "button" : "div";
            return (
              <li key={c.id} className={s.check}>
                <Row className={s.checkRow} {...(expandable ? { type: "button" as const, onClick: () => toggle(c.id), "aria-expanded": open.has(c.id) } : {})}>
                  <span className={s.mark} data-status={run ? c.status : undefined} aria-hidden>
                    {run ? MARK[c.status] : "·"}
                  </span>
                  <div className={s.grow}>
                    <div className={s.checkName}>{t(`diagnostics.checks.${c.id}`)}</div>
                    {run && c.finding ? <div className={s.checkSummary}>{t(`${f}.summary`)}</div> : null}
                  </div>
                  {run ? (
                    <Badge tone={c.status === "working" ? "success" : c.status === "warning" ? "warning" : c.status === "failed" ? "error" : "neutral"}>{t(`diagnostics.status.${c.status}`)}</Badge>
                  ) : null}
                </Row>
                {expandable && open.has(c.id) ? (
                  <dl className={s.detail}>
                    <dt>{t("diagnostics.labels.what")}</dt>
                    <dd>{t(`${f}.summary`)}</dd>
                    <dt>{t("diagnostics.labels.causes")}</dt>
                    <dd>{t(`${f}.causes`, { defaultValue: "—" })}</dd>
                    <dt>{t("diagnostics.labels.actions")}</dt>
                    <dd>{t(`${f}.actions`, { defaultValue: "—" })}</dd>
                    {Object.keys(c.evidence).length ? (
                      <>
                        <dt>{t("diagnostics.labels.evidence")}</dt>
                        <dd className="mono" style={{ fontSize: "var(--text-xs)" }}>
                          {JSON.stringify(c.evidence)}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Card>
    </>
  );
}

const LEVELS: (LogLevel | "all")[] = ["all", "error", "warn", "info", "debug"];
const CATEGORIES: (LogCategory | "all")[] = ["all", "connection", "server", "protocol", "auth", "dns", "network", "firewall", "service"];
const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function Logs() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const logs = useApp((st) => st.logs);
  const [level, setLevel] = useState<LogLevel | "all">("all");
  const [category, setCategory] = useState<LogCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [live, setLive] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  const visible = useMemo(
    () =>
      logs.filter(
        (l) =>
          (level === "all" || RANK[l.level] <= RANK[level]) &&
          (category === "all" || l.category === category) &&
          (!query || `${l.event} ${l.message}`.toLowerCase().includes(query.toLowerCase())),
      ),
    [logs, level, category, query],
  );
  useEffect(() => {
    if (live) end.current?.scrollIntoView({ block: "nearest" });
  }, [visible.length, live]);

  return (
    <>
      <p className={s.intro}>{t("diagnostics.logs.intro")}</p>
      <div className={s.toolbar}>
        <div style={{ width: 240 }}>
          <SearchField label={t("diagnostics.logs.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Select<LogLevel | "all"> label={t("diagnostics.logs.level")} value={level} onValueChange={setLevel} options={LEVELS.map((l) => ({ value: l, label: l === "all" ? t("diagnostics.logs.all") : t(`diagnostics.logs.levels.${l}`) }))} />
        <Select<LogCategory | "all"> label={t("diagnostics.logs.category")} value={category} onValueChange={setCategory} options={CATEGORIES.map((c) => ({ value: c, label: c === "all" ? t("diagnostics.logs.all") : t(`diagnostics.logs.categories.${c}`) }))} />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Switch label={t("diagnostics.logs.live")} checked={live} onCheckedChange={setLive} />
          {t("diagnostics.logs.live")}
        </label>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <Button
            icon={<Download size={16} />}
            onClick={async () => {
              const text = await transport().call("export_logs").catch(() => null);
              if (text === null) return;
              const saved = await transport().app.saveTextFile(`apexy-log-${new Date().toISOString().slice(0, 10)}.txt`, text);
              if (saved) toast({ tone: "success", title: t("diagnostics.logs.exported") });
            }}
          >
            {t("diagnostics.logs.export")}
          </Button>
          <Button
            variant="ghost"
            icon={<Trash size={16} />}
            onClick={async () => {
              if (!(await confirm({ title: t("actions.clear"), body: t("diagnostics.logs.clearConfirm"), danger: true, confirmLabel: t("actions.clear") }))) return;
              await transport().call("clear_logs");
              useApp.setState({ logs: [] });
            }}
          >
            {t("actions.clear")}
          </Button>
        </span>
      </div>
      {visible.length === 0 ? (
        <Card>
          <EmptyState icon={<ScrollText size={22} />} title={t("diagnostics.logs.empty.title")} body={t("diagnostics.logs.empty.body")} />
        </Card>
      ) : (
        <div className={s.logTable} role="log" aria-live={live ? "polite" : "off"} aria-label={t("diagnostics.logs.title")}>
          {visible.map((l) => (
            <div key={l.seq} className={s.logRow} data-level={l.level}>
              <span title={new Date(l.at).toISOString()}>{new Date(l.at).toLocaleString(i18n.language)}</span>
              <span>{t(`diagnostics.logs.levels.${l.level}`)}</span>
              <span>{t(`diagnostics.logs.categories.${l.category}`)}</span>
              <span>{l.event}</span>
              <span className={s.logMessage}>{l.message}</span>
            </div>
          ))}
          <div ref={end} />
        </div>
      )}
    </>
  );
}
