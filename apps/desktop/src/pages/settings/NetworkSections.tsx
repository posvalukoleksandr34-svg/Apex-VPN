import { AppWindow, Plus, Wifi, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { transport } from "@/app/transportRef";
import { Badge, Banner, Button, Dialog, EmptyState, IconButton, RadioCards, SearchField, Select, SettingRow, Spinner, Switch, SwitchRow, TextField, useConfirm } from "@/design";
import type { LogLevel, NetworkKind, SplitTunnelMode, TrustedNetwork, TrustedNetworkPolicy } from "@/protocol";
import { useApp } from "@/state/store";
import s from "./Settings.module.css";
import { useServiceSettings } from "./useSettings";

export function SplitTunnelingSection() {
  const { t } = useTranslation();
  const { settings, save } = useServiceSettings();
  const caps = useApp((st) => st.capabilities);
  const [picking, setPicking] = useState(false);
  if (!settings) return null;
  const st = settings.splitTunnel;
  const enforced = caps?.splitTunnel.status === "available";
  return (
    <>
      <p className={s.intro}>{t("settings.splitTunneling.intro")}</p>
      {!enforced && st.mode !== "off" ? (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Banner tone="warning">{t("settings.splitTunneling.notEnforced")}</Banner>
        </div>
      ) : null}
      <RadioCards<SplitTunnelMode>
        label={t("settings.sections.splitTunneling")}
        value={st.mode}
        onValueChange={(mode) => void save({ splitTunnel: { ...st, mode } })}
        options={(["off", "exclude_apps", "only_apps"] as const).map((m) => ({
          value: m,
          title: t(`settings.splitTunneling.modes.${m}.name`),
          description: t(`settings.splitTunneling.modes.${m}.desc`),
          badge: m === "off" ? <Badge tone="accent">{t("common.recommended")}</Badge> : !enforced ? <Badge tone="outline">{t("common.comingSoon")}</Badge> : undefined,
        }))}
      />
      {st.mode !== "off" ? (
        <div className={`${s.card} ${s.cardPadded}`} style={{ marginTop: "var(--space-4)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ fontWeight: 600 }}>{t("settings.splitTunneling.apps")}</strong>
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setPicking(true)}>
              {t("settings.splitTunneling.addApp")}
            </Button>
          </div>
          {st.apps.length === 0 ? (
            <EmptyState icon={<AppWindow size={22} />} title={t("settings.splitTunneling.noApps.title")} body={t("settings.splitTunneling.noApps.body")} />
          ) : (
            <ul className={s.list}>
              {st.apps.map((app) => (
                <li key={app.path} className={s.listRow}>
                  <Switch
                    label={app.name}
                    checked={app.enabled}
                    onCheckedChange={(enabled) => void save({ splitTunnel: { ...st, apps: st.apps.map((a) => (a.path === app.path ? { ...a, enabled } : a)) } })}
                  />
                  <div className={s.grow}>
                    <div>{app.name}</div>
                    <div className={`${s.note} mono`} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {app.path}
                    </div>
                  </div>
                  <IconButton size="sm" label={t("actions.remove")} icon={<X size={14} />} onClick={() => void save({ splitTunnel: { ...st, apps: st.apps.filter((a) => a.path !== app.path) } })} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <AppPicker
        open={picking}
        onClose={() => setPicking(false)}
        exclude={st.apps.map((a) => a.path)}
        onPick={(app) => void save({ splitTunnel: { ...st, apps: [...st.apps, { ...app, enabled: true }] } })}
      />
    </>
  );
}

function AppPicker({ open, onClose, exclude, onPick }: { open: boolean; onClose(): void; exclude: string[]; onPick(a: { name: string; path: string }): void }) {
  const { t } = useTranslation();
  const [apps, setApps] = useState<{ name: string; path: string }[] | null>(null);
  const [q, setQ] = useState("");
  const filtered = useMemo(() => (apps ?? []).filter((a) => !exclude.includes(a.path) && a.name.toLowerCase().includes(q.toLowerCase())), [apps, q, exclude]);
  useEffect(() => {
    if (open && !apps) void transport().app.installedApps().then(setApps, () => setApps([]));
  }, [open, apps]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={t("settings.splitTunneling.addApp")} wide>
      <SearchField label={t("settings.splitTunneling.searchApps")} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {!apps ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "var(--space-6) 0" }}>
          <Spinner label={t("common.loading")} /> {t("settings.splitTunneling.loadingApps")}
        </div>
      ) : (
        <ul className={s.list} style={{ maxHeight: 360, overflowY: "auto", marginTop: "var(--space-3)" }}>
          {filtered.map((a) => (
            <li key={a.path} className={s.listRow}>
              <div className={s.grow}>
                <div>{a.name}</div>
                <div className={`${s.note} mono`} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {a.path}
                </div>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  onPick(a);
                  onClose();
                }}
              >
                {t("actions.add")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

export function NetworkSection() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { settings, save } = useServiceSettings();
  const [mtuDraft, setMtuDraft] = useState<string | null>(null);
  if (!settings) return null;
  const n = settings.network;
  const mtuValue = mtuDraft ?? (n.mtu === null ? "" : String(n.mtu));
  const mtuNumber = Number(mtuValue);
  const mtuInvalid = mtuValue !== "" && (!Number.isInteger(mtuNumber) || mtuNumber < 1280 || mtuNumber > 1500);
  const applyMtu = async () => {
    const next = mtuValue === "" ? null : mtuNumber;
    if (next === n.mtu || mtuInvalid) return;
    if (next !== null && !(await confirm({ title: t("settings.network.mtuWarningTitle"), body: t("settings.network.mtuWarningBody") }))) {
      setMtuDraft(null);
      return;
    }
    await save({ network: { ...n, mtu: next } });
    setMtuDraft(null);
  };
  return (
    <>
      <p className={s.intro}>{t("settings.network.intro")}</p>
      <div className={s.card}>
        <SwitchRow label={t("settings.network.ipv6")} description={t("settings.network.ipv6Desc")} checked={n.enableIpv6} onCheckedChange={(enableIpv6) => void save({ network: { ...n, enableIpv6 } })} />
        <SwitchRow label={t("settings.network.blockIpv6")} description={t("settings.network.blockIpv6Desc")} checked={n.blockIpv6Leaks} onCheckedChange={(blockIpv6Leaks) => void save({ network: { ...n, blockIpv6Leaks } })} />
        <SwitchRow label={t("settings.network.allowLan")} description={t("settings.network.allowLanDesc")} checked={settings.allowLan} onCheckedChange={(allowLan) => void save({ allowLan })} />
        <SettingRow label={t("settings.network.nat")} description={t("settings.network.natDesc")}>
          <span />
        </SettingRow>
      </div>
      <h3 className={s.subTitle}>{t("actions.showAdvanced")}</h3>
      <div className={s.card}>
        <SettingRow label={t("settings.network.mtu")} description={t("settings.network.mtuDesc")}>
          <div style={{ width: 150 }}>
            <TextField
              label={t("settings.network.mtu")}
              placeholder={`${t("settings.network.mtuAuto")} (1420)`}
              inputMode="numeric"
              value={mtuValue}
              error={mtuInvalid ? "1280–1500" : undefined}
              onChange={(e) => setMtuDraft(e.target.value.replace(/\D/g, ""))}
              onBlur={() => void applyMtu()}
              onKeyDown={(e) => e.key === "Enter" && void applyMtu()}
            />
          </div>
        </SettingRow>
        <SettingRow label={t("settings.network.keepalive")} description={t("settings.network.keepaliveDesc")}>
          <Select
            label={t("settings.network.keepalive")}
            value={String(n.persistentKeepalive)}
            onValueChange={(v) => void save({ network: { ...n, persistentKeepalive: Number(v) } })}
            options={["0", "15", "25", "60"].map((v) => ({ value: v, label: v === "0" ? t("common.off") : `${v} s` }))}
          />
        </SettingRow>
      </div>
    </>
  );
}

export function AutoConnectSection() {
  const { t } = useTranslation();
  const { settings, save } = useServiceSettings();
  const network = useApp((st) => st.network);
  const caps = useApp((st) => st.capabilities);
  const prefs = useApp((st) => st.prefs);
  const [editing, setEditing] = useState<TrustedNetwork | null>(null);
  if (!settings) return null;
  const a = settings.autoConnect;
  const current = network?.primary;
  const upsert = (net: TrustedNetwork) => {
    const list = settings.trustedNetworks.some((x) => x.id === net.id) ? settings.trustedNetworks.map((x) => (x.id === net.id ? net : x)) : [...settings.trustedNetworks, net];
    void save({ trustedNetworks: list });
    setEditing(null);
  };
  const connectOnLaunch = prefs.profiles.some((p) => p.connectOnLaunch);
  return (
    <>
      <p className={s.intro}>{t("settings.autoConnect.intro")}</p>
      <div className={s.card}>
        <SwitchRow
          label={t("settings.autoConnect.onAppStart")}
          checked={connectOnLaunch}
          disabled={prefs.profiles.length === 0 && !connectOnLaunch}
          description={prefs.profiles.length === 0 ? t("profiles.empty.body") : undefined}
          onCheckedChange={(on) =>
            useApp.getState().setPrefs({ profiles: prefs.profiles.map((p, i) => ({ ...p, connectOnLaunch: on ? (prefs.activeProfileId ? p.id === prefs.activeProfileId : i === 0) : false })) })
          }
        />
        <SwitchRow label={t("settings.autoConnect.onSystemStart")} checked={a.onSystemStart} onCheckedChange={(on) => void save({ autoConnect: { ...a, onSystemStart: on } })} />
        <SwitchRow label={t("settings.autoConnect.onUntrusted")} checked={a.onUntrustedNetwork} onCheckedChange={(on) => void save({ autoConnect: { ...a, onUntrustedNetwork: on } })} />
        <SwitchRow label={t("settings.autoConnect.onOpenWifi")} checked={a.onOpenWifi} onCheckedChange={(on) => void save({ autoConnect: { ...a, onOpenWifi: on } })} />
        <SwitchRow label={t("settings.autoConnect.reconnectOnline")} checked={a.reconnectWhenOnline} onCheckedChange={(on) => void save({ autoConnect: { ...a, reconnectWhenOnline: on } })} />
      </div>

      <h3 className={s.subTitle}>{t("settings.autoConnect.trustedTitle")}</h3>
      <p className={s.intro}>{t("settings.autoConnect.trustedIntro")}</p>
      <div style={{ marginBottom: "var(--space-4)" }}>
        <Banner tone="warning">{t("settings.autoConnect.trustedWarning")}</Banner>
      </div>
      {caps?.wifiDetection.status === "unavailable" ? (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Banner>{t("settings.autoConnect.wifiUnavailable")}</Banner>
        </div>
      ) : null}
      <div className={`${s.card} ${s.cardPadded}`}>
        {current ? <p className={s.note}>{t("settings.autoConnect.current", { name: current.ssid ?? current.interfaceName })}</p> : null}
        {settings.trustedNetworks.length === 0 ? (
          <EmptyState icon={<Wifi size={22} />} title={t("settings.autoConnect.noTrusted.title")} body={t("settings.autoConnect.noTrusted.body")} />
        ) : (
          <ul className={s.list}>
            {settings.trustedNetworks.map((net) => (
              <li key={net.id} className={s.listRow}>
                <Wifi size={16} aria-hidden />
                <div className={s.grow}>
                  <div>{net.name}</div>
                  <div className={s.note}>
                    {net.ssid ? `${t("settings.autoConnect.ssid")}: ${net.ssid}` : t("settings.autoConnect.wired")} · {t(`settings.autoConnect.kinds.${net.kind}`)}
                  </div>
                </div>
                <Badge tone={net.policy === "bypass" ? "warning" : net.policy === "require_vpn" ? "success" : "neutral"}>{t(`settings.autoConnect.policies.${net.policy}`)}</Badge>
                <Button size="sm" variant="ghost" onClick={() => setEditing(net)}>
                  {t("actions.edit")}
                </Button>
                <IconButton size="sm" label={t("actions.remove")} icon={<X size={14} />} onClick={() => void save({ trustedNetworks: settings.trustedNetworks.filter((x) => x.id !== net.id) })} />
              </li>
            ))}
          </ul>
        )}
        <div className={s.inlineForm}>
          {current && !settings.trustedNetworks.some((x) => (current.ssid ? x.ssid === current.ssid : x.id === current.id)) ? (
            <Button
              icon={<Plus size={14} />}
              onClick={() =>
                setEditing({
                  id: current.ssid ? `wifi:${current.ssid}` : current.id,
                  name: current.ssid ?? current.interfaceName,
                  ssid: current.ssid,
                  policy: "optional",
                  kind: "home",
                })
              }
            >
              {t("settings.autoConnect.addCurrent")}
            </Button>
          ) : null}
          <Button variant="ghost" icon={<Plus size={14} />} onClick={() => setEditing({ id: `wifi:${Date.now()}`, name: "", ssid: "", policy: "optional", kind: "other" })}>
            {t("settings.autoConnect.addNetwork")}
          </Button>
        </div>
      </div>
      {editing ? <TrustedNetworkDialog value={editing} onClose={() => setEditing(null)} onSave={upsert} /> : null}
    </>
  );
}

function TrustedNetworkDialog({ value, onClose, onSave }: { value: TrustedNetwork; onClose(): void; onSave(n: TrustedNetwork): void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const valid = draft.name.trim().length > 0 && (draft.ssid === null || (draft.ssid.length > 0 && draft.ssid.length <= 32));
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("settings.autoConnect.addNetwork")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("actions.cancel")}
          </Button>
          <Button variant="primary" disabled={!valid} onClick={() => onSave({ ...draft, name: draft.name.trim(), id: draft.ssid ? `wifi:${draft.ssid}` : draft.id })}>
            {t("actions.save")}
          </Button>
        </>
      }
    >
      <div style={{ display: "grid", gap: "var(--space-4)" }}>
        <TextField label={t("settings.autoConnect.name")} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
        {draft.ssid !== null ? <TextField label={t("settings.autoConnect.ssid")} value={draft.ssid} maxLength={32} onChange={(e) => setDraft({ ...draft, ssid: e.target.value })} /> : null}
        <SettingRow label={t("settings.autoConnect.kind")}>
          <Select<NetworkKind>
            label={t("settings.autoConnect.kind")}
            value={draft.kind}
            onValueChange={(kind) => setDraft({ ...draft, kind })}
            options={(["home", "work", "public", "travel", "other"] as const).map((k) => ({ value: k, label: t(`settings.autoConnect.kinds.${k}`) }))}
          />
        </SettingRow>
        <RadioCards<TrustedNetworkPolicy>
          label={t("settings.autoConnect.policy")}
          value={draft.policy}
          onValueChange={(policy) => setDraft({ ...draft, policy })}
          options={(["require_vpn", "optional", "bypass"] as const).map((p) => ({ value: p, title: t(`settings.autoConnect.policies.${p}`) }))}
        />
      </div>
    </Dialog>
  );
}

export function AdvancedSection() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { settings, save } = useServiceSettings();
  const tunnel = useApp((st) => st.tunnel);
  if (!settings) return null;
  const logging = settings.logging;
  return (
    <>
      <p className={s.intro}>{t("settings.advanced.intro")}</p>
      <div className={s.card}>
        <SettingRow label={t("settings.advanced.logLevel")}>
          <Select<LogLevel>
            label={t("settings.advanced.logLevel")}
            value={logging.level}
            onValueChange={(level) => void save({ logging: { ...logging, level } })}
            options={(["error", "warn", "info", "debug"] as const).map((l) => ({ value: l, label: t(`diagnostics.logs.levels.${l}`) }))}
          />
        </SettingRow>
        <SettingRow label={t("settings.advanced.diagnosticMode")} description={t("settings.advanced.diagnosticModeDesc")}>
          <Switch
            label={t("settings.advanced.diagnosticMode")}
            checked={logging.diagnosticMode}
            onCheckedChange={async (on) => {
              if (on && !(await confirm({ title: t("settings.advanced.diagnosticWarningTitle"), body: t("settings.advanced.diagnosticWarningBody") }))) return;
              await save({ logging: { ...logging, diagnosticMode: on } });
            }}
          />
        </SettingRow>
        <SettingRow label={t("settings.advanced.interface")}>
          <span className="mono">{tunnel?.state === "connected" ? `${tunnel.details.interface.name} (#${tunnel.details.interface.index ?? "?"})` : "—"}</span>
        </SettingRow>
        <SettingRow label={t("settings.advanced.rotateKey")} description={t("settings.advanced.rotateKeyDesc")}>
          <Button
            size="sm"
            onClick={async () => {
              if (!(await confirm({ title: t("settings.advanced.rotateKey"), body: t("settings.advanced.rotateConfirm") }))) return;
              await transport().call("rotate_device_key");
              await transport().account.enrollDevice().catch(() => {});
            }}
          >
            {t("settings.advanced.rotateKey")}
          </Button>
        </SettingRow>
        <SettingRow label={t("settings.advanced.resetAll")}>
          <Button
            size="sm"
            variant="danger"
            onClick={async () => {
              if (!(await confirm({ title: t("settings.advanced.resetAll"), body: t("settings.advanced.resetConfirm"), danger: true, confirmLabel: t("actions.reset") }))) return;
              const next = await transport().call("reset_settings");
              useApp.setState({ settings: next });
            }}
          >
            {t("actions.reset")}
          </Button>
        </SettingRow>
      </div>
    </>
  );
}
