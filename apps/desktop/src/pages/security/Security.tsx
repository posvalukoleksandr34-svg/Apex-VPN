import { CircleCheck, CircleMinus, CircleX, Play, ShieldQuestion } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { checkIp } from "@/app/actions";
import { transport } from "@/app/transportRef";
import { Badge, Banner, Button, Card, EmptyState, KeyValue, Page, PageHeader, TabPanel, Tabs } from "@/design";
import { webrtcExposure } from "@/features/security/webrtc";
import { bytes, dateTime, duration, relativeTime } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import type { ConnectionReport, LeakTestResult, LeakVerdict } from "@/protocol";
import { useApp } from "@/state/store";
import s from "./Security.module.css";


const TABS = ["overview", "ip", "leaks", "details"] as const;

export default function Security() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { tab = "overview" } = useParams<{ tab: (typeof TABS)[number] }>();
  return (
    <Page>
      <PageHeader title={t("security.title")} />
      <Tabs label={t("security.title")} value={tab} onValueChange={(v) => navigate(`/security/${v}`)} items={TABS.map((k) => ({ value: k, label: t(`security.tabs.${k}`) }))}>
        <TabPanel value="overview">
          <Overview />
        </TabPanel>
        <TabPanel value="ip">
          <IpNetwork />
        </TabPanel>
        <TabPanel value="leaks">
          <LeakTest />
        </TabPanel>
        <TabPanel value="details">
          <Details />
        </TabPanel>
      </Tabs>
    </Page>
  );
}

type FactState = "verified" | "notProtected" | "unverifiable";

function Fact({ label, state, value, why }: { label: string; state: FactState; value?: ReactNode; why: string }) {
  const { t } = useTranslation();
  const icon = state === "verified" ? <CircleCheck size={18} /> : state === "notProtected" ? <CircleX size={18} /> : <CircleMinus size={18} />;
  return (
    <li className={s.fact} data-state={state}>
      <span className={s.factIcon} aria-hidden>
        {icon}
      </span>
      <div className={s.factBody}>
        <div className={s.factTop}>
          <span className={s.factLabel}>{label}</span>
          <span className={s.factValue}>{value}</span>
          <Badge tone={state === "verified" ? "success" : state === "notProtected" ? "error" : "neutral"}>{t(`security.overview.state.${state}`)}</Badge>
        </div>
        <div className={s.factWhy}>{why}</div>
      </div>
    </li>
  );
}

/** Verified only when the service confirms the firewall rules are in force. */
function killSwitchState(unavailable: boolean, activeNow: boolean, lockedDown: boolean, off: boolean, connected: boolean): FactState {
  if (unavailable || off) return "notProtected";
  if (activeNow || lockedDown) return "verified";
  // Configured on, but nothing is being held right now, so there's nothing to verify.
  return connected ? "notProtected" : "unverifiable";
}

function Overview() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tunnel = useApp((st) => st.tunnel);
  const ip = useApp((st) => st.ip);
  const caps = useApp((st) => st.capabilities);
  const settings = useApp((st) => st.settings);
  const connected = tunnel?.state === "connected" ? tunnel.details : null;
  const now = useNow(1000, !!connected);
  const p = connected?.protections;
  const vpnIpSeen = connected && ip?.protected?.viaTunnel && ip.protected.observedAt >= connected.connectedAt;
  const ownSeenThroughVpn = vpnIpSeen && ip?.unprotected && ip.protected?.ip === ip.unprotected.ip;
  const ksUnavailable = caps?.killSwitch.status === "unavailable";

  return (
    <>
      <p className={s.intro}>{t("security.overview.intro")}</p>
      <div style={{ marginBottom: "var(--space-4)" }}>
        <Button variant="primary" icon={<Play size={16} />} onClick={() => navigate("/security/leaks")}>
          {t("security.overview.runCheck")}
        </Button>
      </div>
      <Card flush>
        <ul className={s.facts}>
          <Fact label={t("security.overview.facts.vpn")} state={connected ? "verified" : "notProtected"} why={t(connected ? "security.overview.why.vpnUp" : "security.overview.why.vpnDown")} />
          <Fact
            label={t("security.overview.facts.ip")}
            state={!connected ? "notProtected" : !vpnIpSeen ? "unverifiable" : ownSeenThroughVpn ? "notProtected" : "verified"}
            value={vpnIpSeen ? <span className="mono">{ip!.protected!.ip}</span> : null}
            why={t(!vpnIpSeen ? "security.overview.why.ipUnchecked" : ownSeenThroughVpn ? "security.overview.why.ipOwn" : "security.overview.why.ipChecked")}
          />
          <Fact
            label={t("security.overview.facts.dns")}
            state={p?.dnsLeakBlocking ? "verified" : "notProtected"}
            value={connected ? <span className="mono">{connected.dnsServers.join(", ")}</span> : null}
            why={t(!connected ? "security.overview.why.vpnDown" : p?.dnsLeakBlocking ? "security.overview.why.dnsOn" : "security.overview.why.dnsOff")}
          />
          <Fact
            label={t("security.overview.facts.ipv6")}
            state={!p ? "notProtected" : p.ipv6Tunneled || p.ipv6LeakBlocking ? "verified" : "notProtected"}
            why={t(!p ? "security.overview.why.vpnDown" : p.ipv6Tunneled ? "security.overview.why.ipv6Tunneled" : p.ipv6LeakBlocking ? "security.overview.why.ipv6Blocked" : "security.overview.why.ipv6Open")}
          />
          <Fact
            label={t("security.overview.facts.killSwitch")}
            state={killSwitchState(ksUnavailable, !!p?.killSwitch, tunnel?.state === "disconnected" && tunnel.lockedDown, settings?.killSwitch === "off", !!connected)}
            value={settings ? t(`settings.killSwitch.modes.${settings.killSwitch}.name`) : null}
            why={t(
              ksUnavailable
                ? "security.overview.why.ksUnavailable"
                : settings?.killSwitch === "off"
                  ? "security.overview.why.ksOff"
                  : p?.killSwitch || (tunnel?.state === "disconnected" && tunnel.lockedDown)
                    ? "security.overview.why.ksOn"
                    : "security.overview.why.ksIdle",
            )}
          />
          <Fact
            label={t("security.overview.facts.protocol")}
            state={connected ? "verified" : "unverifiable"}
            value={connected ? t(`settings.protocols.${connected.relay.protocol}.name`) : "—"}
            why={connected ? t("security.overview.why.wireguard") : t("security.overview.why.vpnDown")}
          />
          <Fact
            label={t("security.overview.facts.encryption")}
            state={connected ? "verified" : "notProtected"}
            value={connected ? connected.cipher.data : "—"}
            why={connected ? connected.cipher.handshake : t("security.overview.why.vpnDown")}
          />
          <Fact
            label={t("security.overview.facts.server")}
            state={connected ? "verified" : "unverifiable"}
            value={connected ? `${connected.relay.city}, ${connected.relay.country}` : "—"}
            why={connected ? connected.relay.hostname : t("security.overview.why.vpnDown")}
          />
          <Fact
            label={t("security.overview.facts.duration")}
            state={connected ? "verified" : "unverifiable"}
            value={connected ? duration(now - connected.connectedAt) : "—"}
            why={connected ? dateTime(connected.connectedAt) : t("security.overview.why.vpnDown")}
          />
        </ul>
      </Card>
    </>
  );
}

function IpNetwork() {
  const { t, i18n } = useTranslation();
  const ip = useApp((st) => st.ip);
  const network = useApp((st) => st.network);
  const tunnel = useApp((st) => st.tunnel);
  const [busy, setBusy] = useState(false);
  const current = tunnel?.state === "connected" && ip?.protected?.viaTunnel ? ip.protected : ip?.unprotected ?? null;
  const dns = tunnel?.state === "connected" ? tunnel.details.dnsServers : network?.primary?.dnsServers ?? [];
  const v6 = network?.networks.find((n) => n.hasIpv6);
  const geoMissing = current && current.country === null;
  return (
    <>
      <p className={s.intro}>{t("security.ip.intro")}</p>
      <Card
        actions={
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await checkIp().catch(() => {});
              setBusy(false);
            }}
          >
            {t("security.overview.runCheck")}
          </Button>
        }
        title={t("security.ip.current")}
      >
        {current ? (
          <KeyValue
            items={[
              {
                label: t("security.ip.current"),
                value: (
                  <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                    <span className="mono">{current.ip}</span>
                    <Badge tone={current.viaTunnel ? "success" : "warning"}>{t(current.viaTunnel ? "security.ip.throughVpn" : "security.ip.notThroughVpn")}</Badge>
                    <span style={{ color: "var(--text-subtle)", fontSize: "var(--text-xs)" }}>{relativeTime(current.observedAt, Date.now(), i18n.language)}</span>
                  </span>
                ),
              },
              { label: t("security.ip.yours"), value: ip?.unprotected ? <span className="mono">{ip.unprotected.ip}</span> : "—" },
              { label: t("security.ip.isp"), value: current.organization ?? t("common.unknown") },
              { label: t("security.ip.asn"), value: current.asn ? `AS${current.asn}` : t("common.unknown") },
              { label: t("security.ip.country"), value: current.country ?? t("common.unknown") },
              { label: t("security.ip.city"), value: current.city ?? t("common.unknown") },
              { label: t("security.ip.timezone"), value: current.timezone ?? t("common.unknown") },
              { label: t("security.ip.dns"), value: dns.length ? <span className="mono">{dns.join(", ")}</span> : "—" },
              { label: t("security.ip.ipv6"), value: v6 ? t("security.ip.ipv6Available", { network: v6.interfaceName }) : t("security.ip.ipv6None") },
              { label: t("security.ip.webrtc"), value: <Button size="sm" variant="ghost" onClick={() => (location.hash = "#/security/leaks")}>{t("security.leaks.run")}</Button> },
            ]}
          />
        ) : (
          <p className={s.intro}>{t("security.ip.never")}</p>
        )}
        {geoMissing ? (
          <div style={{ marginTop: "var(--space-4)" }}>
            <Banner>{t("security.ip.geoUnavailable")}</Banner>
          </div>
        ) : null}
      </Card>
    </>
  );
}

const VERDICT_TONE: Record<LeakVerdict, "success" | "error" | "neutral"> = { protected: "success", potential_leak: "error", unable_to_verify: "neutral" };

function LeakTest() {
  const { t } = useTranslation();
  const tunnel = useApp((st) => st.tunnel);
  const ip = useApp((st) => st.ip);
  const [results, setResults] = useState<LeakTestResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const connected = tunnel?.state === "connected";
  const run = async () => {
    setBusy(true);
    try {
      const service = await transport().call("run_leak_tests");
      const observations = await transport().call("get_ip_observations");
      useApp.setState({ ip: observations });
      const vpnIp = observations.protected?.viaTunnel ? observations.protected.ip : null;
      const webrtc = await webrtcExposure(vpnIp, observations.unprotected?.ip ?? ip?.unprotected?.ip ?? null);
      setResults([...service, webrtc]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className={s.intro}>{t("security.leaks.intro")}</p>
      {!connected ? (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Banner tone="warning">{t("security.leaks.connectFirst")}</Banner>
        </div>
      ) : null}
      <div style={{ marginBottom: "var(--space-4)" }}>
        <Button variant="primary" icon={<Play size={16} />} loading={busy} onClick={run}>
          {busy ? t("security.leaks.running") : t("security.leaks.run")}
        </Button>
      </div>
      {!results ? (
        <Card>
          <EmptyState icon={<ShieldQuestion size={22} />} title={t("security.leaks.notRun")} />
        </Card>
      ) : (
        <div className={s.leakGrid}>
          {results.map((r) => (
            <Card key={r.test}>
              <div className={s.leakHead}>
                <span className={s.leakName}>{t(`security.leaks.tests.${r.test}`)}</span>
                <Badge tone={VERDICT_TONE[r.verdict]} dot>
                  {t(`security.leaks.verdict.${r.verdict}`)}
                </Badge>
              </div>
              <p className={s.leakFinding}>{t(`leak.findings.${r.finding}`)}</p>
              {r.observed.length || r.expected.length ? (
                <KeyValue
                  items={[
                    ...(r.observed.length ? [{ label: t("security.leaks.observed"), value: <span className="mono">{r.observed.join(", ")}</span> }] : []),
                    ...(r.expected.length ? [{ label: t("security.leaks.expected"), value: <span className="mono">{r.expected.join(", ")}</span> }] : []),
                  ]}
                />
              ) : null}
              {r.test === "webrtc" ? <p className={s.leakNote}>{t("leak.findings.webrtc_note")}</p> : null}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function Details() {
  const { t, i18n } = useTranslation();
  const tunnel = useApp((st) => st.tunnel);
  const stats = useApp((st) => st.stats);
  const [report, setReport] = useState<ConnectionReport | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const connected = tunnel?.state === "connected" ? tunnel.details : null;
  const now = useNow(1000, !!connected);
  if (!connected) {
    return (
      <Card>
        <EmptyState icon={<ShieldQuestion size={22} />} title={t("security.details.notConnected")} />
      </Card>
    );
  }
  const loadAdvanced = async () => {
    setAdvanced((a) => !a);
    if (!report) setReport(await transport().call("get_connection_report").catch(() => null));
  };
  return (
    <Card>
      <KeyValue
        items={[
          { label: t("security.details.protocol"), value: t(`settings.protocols.${connected.relay.protocol}.name`) },
          { label: t("security.details.cipher"), value: `${connected.cipher.data} · ${connected.cipher.keyExchange}` },
          { label: t("security.details.handshake"), value: <span className="mono">{connected.cipher.handshake}</span> },
          { label: t("security.details.lastHandshake"), value: (stats?.lastHandshake ?? connected.lastHandshake) ? relativeTime((stats?.lastHandshake ?? connected.lastHandshake)!, now, i18n.language) : t("common.never") },
          { label: t("security.details.server"), value: `${connected.relay.hostname} (${connected.relay.city}, ${connected.relay.country})` },
          { label: t("security.details.endpoint"), value: <span className="mono">{connected.endpoint}</span> },
          { label: t("security.details.interface"), value: connected.interface.name },
          { label: t("security.details.vpnIp"), value: <span className="mono">{[connected.tunnelIpv4, connected.tunnelIpv6].filter(Boolean).join(", ")}</span> },
          { label: t("security.details.dns"), value: <span className="mono">{connected.dnsServers.join(", ") || "—"}</span> },
          { label: t("security.details.mtu"), value: connected.mtu },
          { label: t("security.details.sent"), value: stats ? bytes(stats.txBytes, i18n.language) : "—" },
          { label: t("security.details.received"), value: stats ? bytes(stats.rxBytes, i18n.language) : "—" },
          { label: t("security.details.uptime"), value: duration(now - connected.connectedAt) },
        ]}
      />
      <div style={{ marginTop: "var(--space-4)" }}>
        <Button variant="ghost" size="sm" onClick={loadAdvanced} aria-expanded={advanced}>
          {advanced ? t("actions.hideAdvanced") : t("security.details.advanced")}
        </Button>
      </div>
      {advanced ? (
        <div style={{ marginTop: "var(--space-4)" }}>
          <KeyValue
            items={[
              { label: t("security.details.localKey"), value: <span className="mono">{connected.localPublicKey}</span> },
              { label: t("security.details.serverKey"), value: <span className="mono">{connected.serverPublicKey}</span> },
              { label: t("security.details.luid"), value: <span className="mono">{connected.interface.luid ?? "—"} / {connected.interface.index ?? "—"}</span> },
              { label: t("security.details.dnsReported"), value: <span className="mono">{report ? report.effectiveDns.join(", ") || "—" : "…"}</span> },
              { label: t("security.details.routes"), value: <span className="mono">{report ? report.routes.map((r) => r.destination).join(", ") || "—" : "…"}</span> },
              {
                label: t("security.details.firewall"),
                value: report ? (
                  <span>
                    <span className="mono">{report.firewall.policy}</span> · {t("security.details.filters", { count: report.firewall.filterCount })} ·{" "}
                    <Badge tone={report.firewall.verified ? "success" : "warning"}>{t(report.firewall.verified ? "common.verified" : "common.notVerified")}</Badge>
                  </span>
                ) : (
                  "…"
                ),
              },
            ]}
          />
        </div>
      ) : null}
    </Card>
  );
}
