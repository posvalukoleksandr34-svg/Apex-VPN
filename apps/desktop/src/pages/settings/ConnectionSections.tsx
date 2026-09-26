import { Plus, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { transport } from "@/app/transportRef";
import { Badge, Banner, Button, IconButton, RadioCards, Select, SettingRow, SwitchRow, TextField, useConfirm } from "@/design";
import type { DnsMode, DnsTestResult, KillSwitchMode, ProtocolPreference, SmartMode } from "@/protocol";
import { useApp } from "@/state/store";
import s from "./Settings.module.css";
import { useServiceSettings } from "./useSettings";

export function ConnectionSection() {
  const { t } = useTranslation();
  const { settings, save } = useServiceSettings();
  if (!settings) return null;
  const target = settings.defaultTarget;
  const r = settings.network.reconnect;
  const modes: SmartMode[] = ["best_overall", "fastest", "nearest", "lowest_load"];
  return (
    <div className={s.card}>
      <SettingRow
        label={t("settings.connection.defaultTarget")}
        description={target.kind === "server" ? t("settings.connection.defaultServer", { server: target.id }) : undefined}
      >
        <Select<SmartMode | "server">
          label={t("settings.connection.defaultTarget")}
          value={target.kind === "smart" ? target.mode : "server"}
          onValueChange={(v) => v !== "server" && void save({ defaultTarget: { kind: "smart", mode: v, country: null, city: null, features: [] } })}
          options={[
            ...modes.map((m) => ({ value: m, label: t("settings.connection.defaultSmart", { mode: t(`smart.${m}`) }) })),
            ...(target.kind === "server" ? [{ value: "server" as const, label: t("settings.connection.defaultServer", { server: target.id }) }] : []),
          ]}
        />
      </SettingRow>
      <SwitchRow
        label={t("settings.connection.autoReconnect")}
        checked={r.autoReconnect}
        onCheckedChange={(on) => void save({ network: { ...settings.network, reconnect: { ...r, autoReconnect: on } } })}
      />
      <SettingRow label={t("settings.connection.switchServerAfter")}>
        <Select
          label={t("settings.connection.switchServerAfter")}
          value={String(r.switchServerAfter)}
          onValueChange={(v) => void save({ network: { ...settings.network, reconnect: { ...r, switchServerAfter: Number(v) } } })}
          options={["1", "2", "3", "5", "10"].map((v) => ({ value: v, label: v }))}
        />
      </SettingRow>
      <SettingRow label={t("settings.connection.maxAttempts")}>
        <Select
          label={t("settings.connection.maxAttempts")}
          value={String(r.maxAttempts)}
          onValueChange={(v) => void save({ network: { ...settings.network, reconnect: { ...r, maxAttempts: Number(v) } } })}
          options={["0", "5", "10", "30"].map((v) => ({ value: v, label: v }))}
        />
      </SettingRow>
    </div>
  );
}

export function ProtocolsSection() {
  const { t } = useTranslation();
  const { settings, save } = useServiceSettings();
  const caps = useApp((st) => st.capabilities);
  if (!settings) return null;
  const availability = (p: "wireguard" | "openvpn" | "ikev2") => caps?.protocols.find((x) => x.protocol === p)?.availability;
  const unavailableBadge = (p: "wireguard" | "openvpn" | "ikev2") => {
    const a = availability(p);
    if (!a || a.status === "available") return null;
    return <Badge tone="outline">{a.reason === "driver_missing" ? t("settings.protocols.driverMissing") : t("settings.protocols.notBundled")}</Badge>;
  };
  const protocols = ["wireguard", "openvpn", "ikev2"] as const;
  return (
    <>
      <p className={s.intro}>{t("settings.protocols.intro")}</p>
      <RadioCards<ProtocolPreference>
        label={t("settings.sections.protocols")}
        value={settings.protocol}
        onValueChange={(protocol) => void save({ protocol })}
        options={[
          { value: "automatic", title: t("settings.protocols.automatic.name"), description: t("settings.protocols.automatic.desc"), badge: <Badge tone="accent">{t("common.recommended")}</Badge> },
          ...protocols.map((p) => ({
            value: p as ProtocolPreference,
            title: t(`settings.protocols.${p}.name`),
            description: t(`settings.protocols.${p}.desc`),
            badge: unavailableBadge(p),
            disabled: availability(p)?.status === "unavailable",
          })),
        ]}
      />
      <div className={s.protoGrid}>
        {protocols.map((p) => (
          <div key={p} className={`${s.card} ${s.cardPadded}`} style={{ marginBottom: 0 }}>
            <h3 className={s.protoTitle}>
              {t(`settings.protocols.${p}.name`)} {unavailableBadge(p)}
            </h3>
            <dl className={s.protoFacts}>
              {(["pros", "cons", "performance", "stability", "compatibility"] as const).map((k) => (
                <div key={k}>
                  <dt>{t(`settings.protocols.labels.${k}`)}</dt>
                  <dd>{t(`settings.protocols.${p}.${k}`)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </>
  );
}

export function KillSwitchSection() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { settings, save } = useServiceSettings();
  const caps = useApp((st) => st.capabilities);
  if (!settings) return null;
  const available = caps?.killSwitch.status !== "unavailable";
  const change = async (mode: KillSwitchMode) => {
    if (mode === "off" && !(await confirm({ title: t("settings.killSwitch.offConfirmTitle"), body: t("settings.killSwitch.offConfirmBody"), danger: true, confirmLabel: t("actions.disable") }))) return;
    if (mode === "always_on" && !(await confirm({ title: t("settings.killSwitch.alwaysOnConfirmTitle"), body: t("settings.killSwitch.alwaysOnConfirmBody"), confirmLabel: t("actions.enable") }))) return;
    await save({ killSwitch: mode });
  };
  return (
    <>
      <p className={s.intro}>{t("settings.killSwitch.intro")}</p>
      {!available && caps?.killSwitch.status === "unavailable" ? (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Banner tone="error">{t("settings.killSwitch.unavailable", { reason: caps.killSwitch.reason })}</Banner>
        </div>
      ) : null}
      <RadioCards<KillSwitchMode>
        label={t("settings.sections.killSwitch")}
        value={settings.killSwitch}
        onValueChange={(m) => void change(m)}
        options={(["off", "while_connected", "always_on"] as const).map((m) => ({
          value: m,
          title: t(`settings.killSwitch.modes.${m}.name`),
          description: t(`settings.killSwitch.modes.${m}.desc`),
          badge: m === "while_connected" ? <Badge tone="accent">{t("common.recommended")}</Badge> : undefined,
        }))}
      />
      <div className={`${s.card} ${s.cardPadded}`} style={{ marginTop: "var(--space-4)", display: "grid", gap: "var(--space-2)" }}>
        <p>{t("settings.killSwitch.blocked")}</p>
        <p className={s.note}>{t("settings.killSwitch.allowed")}</p>
      </div>
      <div className={s.card}>
        <SwitchRow
          label={t("settings.killSwitch.allowLan")}
          description={t("settings.killSwitch.allowLanDesc")}
          checked={settings.allowLan}
          onCheckedChange={(allowLan) => void save({ allowLan })}
        />
      </div>
    </>
  );
}

function isIp(v: string): boolean {
  const v4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
  return v4.test(v) || (v.includes(":") && /^[0-9a-fA-F:]+$/.test(v));
}

export function DnsSection() {
  const { t } = useTranslation();
  const { settings, save } = useServiceSettings();
  const tunnel = useApp((st) => st.tunnel);
  const network = useApp((st) => st.network);
  const [draft, setDraft] = useState("");
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<DnsTestResult[] | null>(null);
  if (!settings) return null;
  const dns = settings.dns;
  const inUse = tunnel?.state === "connected" ? tunnel.details.dnsServers : network?.primary?.dnsServers ?? [];
  const addServer = () => {
    const v = draft.trim();
    if (!isIp(v) || dns.customServers.includes(v)) return;
    setDraft("");
    void save({ dns: { ...dns, customServers: [...dns.customServers, v] } });
  };
  return (
    <>
      <p className={s.intro}>{t("settings.dns.intro")}</p>
      <div className={`${s.card} ${s.cardPadded}`}>
        <div className={s.note}>{t("settings.dns.status")}</div>
        <div style={{ marginTop: 4, fontWeight: 500 }}>
          {tunnel?.state === "connected"
            ? t("settings.dns.statusConnected", { servers: inUse.join(", ") || "—" })
            : t("settings.dns.statusDisconnected", { servers: inUse.join(", ") || "—" })}
        </div>
        <div className={s.inlineForm}>
          <Button
            size="sm"
            loading={testing}
            onClick={async () => {
              setTesting(true);
              setResults(await transport().call("test_dns", { servers: null }).catch(() => []));
              setTesting(false);
            }}
          >
            {testing ? t("settings.dns.testing") : t("settings.dns.test")}
          </Button>
        </div>
        {results ? (
          <ul className={s.list} style={{ marginTop: "var(--space-3)" }}>
            {results.map((r) => (
              <li key={r.server} className={s.note}>
                <Badge tone={r.ok ? "success" : "error"} dot>
                  {r.ok ? t("settings.dns.testResult", { server: r.server, outcome: r.outcome, ms: r.rttMs }) : t("settings.dns.testFailed", { server: r.server, outcome: r.outcome })}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <RadioCards<DnsMode>
        label={t("settings.dns.mode")}
        value={dns.mode}
        onValueChange={(mode) => {
          if (mode === "custom" && dns.customServers.length === 0) {
            void save({ dns: { ...dns, mode, customServers: ["9.9.9.9"] } });
            return;
          }
          void save({ dns: { ...dns, mode } });
        }}
        options={(["vpn", "custom", "system"] as const).map((m) => ({
          value: m,
          title: t(`settings.dns.modes.${m}.name`),
          description: t(`settings.dns.modes.${m}.desc`),
          badge: m === "vpn" ? <Badge tone="accent">{t("common.recommended")}</Badge> : m === "system" ? <Badge tone="warning">{t("settings.dns.leakRisk")}</Badge> : undefined,
        }))}
      />
      {dns.mode === "custom" ? (
        <div className={`${s.card} ${s.cardPadded}`} style={{ marginTop: "var(--space-4)" }}>
          <div style={{ fontWeight: 500 }}>{t("settings.dns.customServers")}</div>
          <ul className={s.list}>
            {dns.customServers.map((ip) => (
              <li key={ip} className={s.listRow}>
                <span className={`${s.grow} mono`}>{ip}</span>
                <IconButton
                  size="sm"
                  label={t("actions.remove")}
                  icon={<X size={14} />}
                  disabled={dns.customServers.length === 1}
                  onClick={() => void save({ dns: { ...dns, customServers: dns.customServers.filter((x) => x !== ip) } })}
                />
              </li>
            ))}
          </ul>
          {dns.customServers.length < 4 ? (
            <div className={s.inlineForm}>
              <div style={{ minWidth: 220 }}>
                <TextField
                  label={t("settings.dns.addServer")}
                  placeholder={t("settings.dns.customPlaceholder")}
                  value={draft}
                  error={draft && !isIp(draft.trim()) ? t("settings.dns.invalidIp") : undefined}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addServer()}
                />
              </div>
              <Button icon={<Plus size={16} />} onClick={addServer} disabled={!isIp(draft.trim())}>
                {t("actions.add")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className={s.card} style={{ marginTop: "var(--space-4)" }}>
        <SwitchRow
          label={t("settings.dns.blockLeaks")}
          description={t("settings.dns.blockLeaksDesc")}
          checked={dns.blockLeaks}
          disabled={dns.mode === "system"}
          onCheckedChange={(blockLeaks) => void save({ dns: { ...dns, blockLeaks } })}
        />
      </div>
      <p className={s.note}>{t("settings.dns.dohNote")}</p>
    </>
  );
}
