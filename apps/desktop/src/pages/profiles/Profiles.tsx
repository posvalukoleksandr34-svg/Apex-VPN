import { Briefcase, EllipsisVertical, Gamepad2, Layers, Pencil, Plane, Plus, Shield, Sparkles, Trash, Tv } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { applyProfile } from "@/app/actions";
import { Badge, Button, Card, Dialog, EmptyState, IconButton, Menu, MenuItem, Page, PageHeader, Select, Switch, TextField, useConfirm, useToast } from "@/design";
import { smartTarget } from "@/features/servers/model";
import type { ConnectTarget, KillSwitchMode, ProtocolPreference, SmartMode } from "@/protocol";
import { useApp } from "@/state/store";
import type { Profile, ProfileKind } from "@/state/types";
import s from "./Profiles.module.css";

const ICONS: Record<ProfileKind, ReactNode> = {
  gaming: <Gamepad2 size={20} />,
  streaming: <Tv size={20} />,
  work: <Briefcase size={20} />,
  privacy: <Shield size={20} />,
  travel: <Plane size={20} />,
  custom: <Sparkles size={20} />,
};

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `p-${Date.now()}`);

function template(kind: ProfileKind, name: string): Profile {
  const base = { id: newId(), name, kind, connectOnLaunch: false };
  switch (kind) {
    case "gaming":
      return { ...base, target: smartTarget("fastest", undefined, undefined, ["gaming"]), overrides: { protocol: "wireguard" } };
    case "streaming":
      return { ...base, target: smartTarget("best_overall", undefined, undefined, ["streaming"]), overrides: {} };
    case "work":
      return { ...base, target: smartTarget("nearest"), overrides: { killSwitch: "while_connected", allowLan: true } };
    case "privacy":
      return { ...base, target: smartTarget("best_overall", undefined, undefined, ["privacy"]), overrides: { killSwitch: "always_on", allowLan: false } };
    case "travel":
      return { ...base, target: smartTarget("fastest"), overrides: { killSwitch: "while_connected" } };
    case "custom":
      return { ...base, target: smartTarget("best_overall"), overrides: {} };
  }
}

export default function Profiles() {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const profiles = useApp((st) => st.prefs.profiles);
  const activeId = useApp((st) => st.prefs.activeProfileId);
  const setPrefs = useApp((st) => st.setPrefs);
  const connected = useApp((st) => st.tunnel?.state === "connected");
  const [editing, setEditing] = useState<{ profile: Profile; isNew: boolean } | null>(null);

  const save = (p: Profile) => {
    const exists = profiles.some((x) => x.id === p.id);
    setPrefs({ profiles: exists ? profiles.map((x) => (x.id === p.id ? p : x)) : [...profiles, p] });
    setEditing(null);
  };

  const use = async (p: Profile) => {
    if (connected && !(await confirm({ title: p.name, body: t("profiles.applyWhileConnected"), confirmLabel: t("profiles.use") }))) return;
    try {
      await applyProfile(p);
    } catch (e) {
      toast({ tone: "error", title: t("common.somethingWrong"), body: (e as Error).message });
    }
  };

  return (
    <Page>
      <PageHeader
        title={t("profiles.title")}
        subtitle={t("profiles.subtitle")}
        actions={
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing({ profile: template("custom", ""), isNew: true })}>
            {t("profiles.new")}
          </Button>
        }
      />
      {profiles.length === 0 ? (
        <Card>
          <EmptyState icon={<Layers size={22} />} title={t("profiles.empty.title")} body={t("profiles.empty.body")} />
        </Card>
      ) : (
        <div className={s.grid}>
          {profiles.map((p) => (
            <Card key={p.id} className={s.profile} data-active={p.id === activeId}>
              <div className={s.head}>
                <span className={s.icon} aria-hidden>
                  {ICONS[p.kind]}
                </span>
                <div className={s.grow}>
                  <div className={s.name}>{p.name}</div>
                  <div className={s.sub}>{describeTarget(t, p.target)}</div>
                </div>
                {p.id === activeId ? <Badge tone="success">{t("profiles.active")}</Badge> : null}
                <Menu trigger={<IconButton size="sm" label={t("actions.edit")} icon={<EllipsisVertical size={16} />} tooltip={false} />}>
                  <MenuItem icon={<Pencil size={14} />} onSelect={() => setEditing({ profile: p, isNew: false })}>
                    {t("actions.edit")}
                  </MenuItem>
                  <MenuItem
                    icon={<Trash size={14} />}
                    danger
                    onSelect={async () => {
                      if (!(await confirm({ title: t("actions.delete"), body: t("profiles.deleteConfirm", { name: p.name }), danger: true, confirmLabel: t("actions.delete") }))) return;
                      setPrefs({ profiles: profiles.filter((x) => x.id !== p.id), activeProfileId: activeId === p.id ? null : activeId });
                    }}
                  >
                    {t("actions.delete")}
                  </MenuItem>
                </Menu>
              </div>
              <div className={s.tags}>
                {overrideTags(t, p).map((tag) => (
                  <Badge key={tag} tone="outline">
                    {tag}
                  </Badge>
                ))}
              </div>
              <Button variant={p.id === activeId ? "secondary" : "primary"} onClick={() => void use(p)}>
                {t("profiles.use")}
              </Button>
            </Card>
          ))}
        </div>
      )}

      <h2 className={s.templatesTitle}>{t("profiles.templates")}</h2>
      <div className={s.templates}>
        {(["gaming", "streaming", "work", "privacy", "travel"] as const).map((k) => (
          <button key={k} type="button" className={s.template} onClick={() => setEditing({ profile: template(k, t(`profiles.kinds.${k}`)), isNew: true })}>
            <span className={s.icon} aria-hidden>
              {ICONS[k]}
            </span>
            {t(`profiles.kinds.${k}`)}
          </button>
        ))}
      </div>

      {editing ? <ProfileEditor value={editing.profile} isNew={editing.isNew} onClose={() => setEditing(null)} onSave={save} /> : null}
    </Page>
  );
}

function describeTarget(t: (k: string, v?: Record<string, unknown>) => string, target: ConnectTarget): string {
  if (target.kind === "server") return target.id;
  const parts = [t(`smart.${target.mode}`)];
  if (target.city) parts.push(target.city);
  else if (target.country) parts.push(target.country);
  if (target.features.length) parts.push(target.features.map((f) => t(`features.${f}`)).join(", "));
  return parts.join(" · ");
}

function overrideTags(t: (k: string) => string, p: Profile): string[] {
  const o = p.overrides;
  const tags: string[] = [];
  if (o.protocol) tags.push(t(o.protocol === "automatic" ? "dashboard.protocol.automatic" : `settings.protocols.${o.protocol}.name`));
  if (o.killSwitch) tags.push(`${t("profiles.editor.killSwitch")}: ${t(`settings.killSwitch.modes.${o.killSwitch}.name`)}`);
  if (o.dns) tags.push(`DNS: ${t(`settings.dns.modes.${o.dns.mode}.name`)}`);
  if (o.allowLan != null) tags.push(`${t("profiles.editor.allowLan")}: ${o.allowLan ? t("common.on") : t("common.off")}`);
  if (p.connectOnLaunch) tags.push(t("settings.autoConnect.onAppStart"));
  return tags;
}

function ProfileEditor({ value, isNew, onClose, onSave }: { value: Profile; isNew: boolean; onClose(): void; onSave(p: Profile): void }) {
  const { t } = useTranslation();
  const relays = useApp((st) => st.relays);
  const settings = useApp((st) => st.settings);
  const [p, setP] = useState(value);
  const countries = [...new Map((relays?.locations ?? []).map((l) => [l.countryCode, l.country])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const target = p.target.kind === "smart" ? p.target : null;
  const KEEP = "keep";
  const setOverride = <K extends keyof Profile["overrides"]>(k: K, v: Profile["overrides"][K] | undefined) => {
    const overrides = { ...p.overrides };
    if (v === undefined) delete overrides[k];
    else overrides[k] = v;
    setP({ ...p, overrides });
  };
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title={isNew ? t("profiles.editor.createTitle") : t("profiles.editor.title")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("actions.cancel")}
          </Button>
          <Button variant="primary" disabled={!p.name.trim()} onClick={() => onSave({ ...p, name: p.name.trim() })}>
            {t("actions.save")}
          </Button>
        </>
      }
    >
      <div className={s.editor}>
        <TextField label={t("profiles.editor.name")} value={p.name} maxLength={64} onChange={(e) => setP({ ...p, name: e.target.value })} autoFocus />
        <Field label={t("profiles.editor.kind")}>
          <Select<ProfileKind>
            label={t("profiles.editor.kind")}
            value={p.kind}
            onValueChange={(kind) => setP({ ...p, kind })}
            options={(["gaming", "streaming", "work", "privacy", "travel", "custom"] as const).map((k) => ({ value: k, label: t(`profiles.kinds.${k}`) }))}
          />
        </Field>
        <Field label={t("profiles.editor.target")}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Select<SmartMode>
              label={t("servers.smartConnect")}
              value={target?.mode ?? "best_overall"}
              onValueChange={(mode) => setP({ ...p, target: { kind: "smart", mode, country: target?.country ?? null, city: null, features: target?.features ?? [] } })}
              options={(["best_overall", "fastest", "nearest", "lowest_load"] as const).map((m) => ({ value: m, label: t(`smart.${m}`) }))}
            />
            <Select<string>
              label={t("security.ip.country")}
              value={target?.country ?? "any"}
              onValueChange={(c) => setP({ ...p, target: { kind: "smart", mode: target?.mode ?? "best_overall", country: c === "any" ? null : c, city: null, features: target?.features ?? [] } })}
              options={[{ value: "any", label: t("servers.filters.all") }, ...countries.map(([code, name]) => ({ value: code, label: name }))]}
            />
          </div>
        </Field>
        <Field label={t("profiles.editor.protocol")}>
          <Select<ProtocolPreference | typeof KEEP>
            label={t("profiles.editor.protocol")}
            value={p.overrides.protocol ?? KEEP}
            onValueChange={(v) => setOverride("protocol", v === KEEP ? undefined : v)}
            options={[{ value: KEEP, label: t("profiles.editor.keep") }, { value: "automatic", label: t("dashboard.protocol.automatic") }, { value: "wireguard", label: "WireGuard" }]}
          />
        </Field>
        <Field label={t("profiles.editor.killSwitch")}>
          <Select<KillSwitchMode | typeof KEEP>
            label={t("profiles.editor.killSwitch")}
            value={p.overrides.killSwitch ?? KEEP}
            onValueChange={(v) => setOverride("killSwitch", v === KEEP ? undefined : v)}
            options={[{ value: KEEP, label: t("profiles.editor.keep") }, ...(["off", "while_connected", "always_on"] as const).map((m) => ({ value: m, label: t(`settings.killSwitch.modes.${m}.name`) }))]}
          />
        </Field>
        <Field label={t("profiles.editor.dns")}>
          <Select<"vpn" | "system" | typeof KEEP>
            label={t("profiles.editor.dns")}
            value={p.overrides.dns?.mode === "vpn" || p.overrides.dns?.mode === "system" ? p.overrides.dns.mode : KEEP}
            onValueChange={(v) => setOverride("dns", v === KEEP || !settings ? undefined : { ...settings.dns, mode: v })}
            options={[{ value: KEEP, label: t("profiles.editor.keep") }, { value: "vpn", label: t("settings.dns.modes.vpn.name") }, { value: "system", label: t("settings.dns.modes.system.name") }]}
          />
        </Field>
        <Field label={t("profiles.editor.allowLan")}>
          <Select<"on" | "off" | typeof KEEP>
            label={t("profiles.editor.allowLan")}
            value={p.overrides.allowLan == null ? KEEP : p.overrides.allowLan ? "on" : "off"}
            onValueChange={(v) => setOverride("allowLan", v === KEEP ? undefined : v === "on")}
            options={[{ value: KEEP, label: t("profiles.editor.keep") }, { value: "on", label: t("common.on") }, { value: "off", label: t("common.off") }]}
          />
        </Field>
        <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Switch label={t("profiles.editor.connectOnLaunch")} checked={p.connectOnLaunch} onCheckedChange={(connectOnLaunch) => setP({ ...p, connectOnLaunch })} />
          {t("profiles.editor.connectOnLaunch")}
        </label>
      </div>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: "var(--text-sm)", fontWeight: 500 }}>{label}</span>
      {children}
    </div>
  );
}
