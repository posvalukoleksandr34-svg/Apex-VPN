import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { transport } from "@/app/transportRef";
import { Badge, Button, Kbd, Segmented, Select, SettingRow, SwitchRow, useToast } from "@/design";
import { LANGUAGES } from "@/i18n";
import { useApp } from "@/state/store";
import { DEFAULT_SHORTCUTS, type Language, type ShortcutId } from "@/state/types";
import s from "./Settings.module.css";
import { Logo } from "@/shell/Logo";

export function GeneralSection() {
  const { t } = useTranslation();
  const prefs = useApp((st) => st.prefs);
  const setPrefs = useApp((st) => st.setPrefs);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  useEffect(() => {
    void transport().app.getAutostart().then(setAutostart, () => setAutostart(null));
  }, []);
  return (
    <div className={s.card}>
      <SettingRow label={t("settings.general.language")}>
        <Select<Language>
          label={t("settings.general.language")}
          value={prefs.language}
          onValueChange={(language) => setPrefs({ language })}
          options={[{ value: "system", label: t("settings.general.languageSystem") }, ...LANGUAGES.map((l) => ({ value: l.code as Language, label: l.name }))]}
        />
      </SettingRow>
      <SwitchRow
        label={t("settings.general.launchOnStartup")}
        checked={!!autostart}
        disabled={autostart === null}
        onCheckedChange={async (on) => {
          await transport().app.setAutostart(on);
          setAutostart(on);
        }}
      />
      <SwitchRow
        label={t("settings.general.closeToTray")}
        checked={prefs.closeToTray}
        onCheckedChange={(on) => setPrefs({ closeToTray: on })}
      />
      <SwitchRow label={t("settings.general.confirmDisconnect")} checked={prefs.confirmDisconnect} onCheckedChange={(on) => setPrefs({ confirmDisconnect: on })} />
      <SettingRow label={t("settings.general.autoUpdates")} description={t("settings.general.autoUpdatesNote")}>
        <Badge tone="outline">{t("common.unavailable")}</Badge>
      </SettingRow>
    </div>
  );
}

export function AppearanceSection() {
  const { t } = useTranslation();
  const prefs = useApp((st) => st.prefs);
  const setPrefs = useApp((st) => st.setPrefs);
  return (
    <div className={s.card}>
      <SettingRow label={t("settings.appearance.theme")}>
        <Segmented
          label={t("settings.appearance.theme")}
          value={prefs.theme}
          onValueChange={(theme) => setPrefs({ theme })}
          options={(["dark", "light", "system"] as const).map((v) => ({ value: v, label: t(`settings.appearance.themes.${v}`) }))}
        />
      </SettingRow>
      <SettingRow label={t("settings.appearance.density")}>
        <Segmented
          label={t("settings.appearance.density")}
          value={prefs.density}
          onValueChange={(density) => setPrefs({ density })}
          options={(["comfortable", "compact"] as const).map((v) => ({ value: v, label: t(`settings.appearance.densities.${v}`) }))}
        />
      </SettingRow>
      <SettingRow label={t("settings.appearance.motion")}>
        <Segmented
          label={t("settings.appearance.motion")}
          value={prefs.motion}
          onValueChange={(motion) => setPrefs({ motion })}
          options={(["system", "reduced", "full"] as const).map((v) => ({ value: v, label: t(`settings.appearance.motions.${v}`) }))}
        />
      </SettingRow>
      <SettingRow label={t("settings.appearance.textSize")}>
        <Segmented
          label={t("settings.appearance.textSize")}
          value={String(prefs.textScale)}
          onValueChange={(v) => setPrefs({ textScale: Number(v) })}
          options={["0.9", "1", "1.1", "1.25"].map((v) => ({ value: v, label: <span style={{ fontSize: `${Number(v) * 13}px` }}>A</span> }))}
        />
      </SettingRow>
    </div>
  );
}

export function NotificationsSection() {
  const { t } = useTranslation();
  const notify = useApp((st) => st.prefs.notify);
  const setPrefs = useApp((st) => st.setPrefs);
  const keys = ["connected", "disconnected", "connectionFailed", "killSwitch", "security", "updates"] as const;
  return (
    <>
      <p className={s.intro}>{t("settings.notifications.intro")}</p>
      <div className={s.card}>
        {keys.map((k) => (
          <SwitchRow key={k} label={t(`settings.notifications.${k}`)} checked={notify[k]} onCheckedChange={(on) => setPrefs({ notify: { ...notify, [k]: on } })} />
        ))}
      </div>
    </>
  );
}

function comboFromEvent(e: React.KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (!parts.length) return null; // require a modifier
  parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
  return parts.join("+");
}

export function ShortcutsSection() {
  const { t } = useTranslation();
  const toast = useToast();
  const shortcuts = useApp((st) => st.prefs.shortcuts);
  const setPrefs = useApp((st) => st.setPrefs);
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const ids = Object.keys(DEFAULT_SHORTCUTS) as ShortcutId[];
  return (
    <>
      <p className={s.intro}>{t("settings.shortcuts.intro")}</p>
      <div className={s.card}>
        {ids.map((id) => (
          <SettingRow key={id} label={t(`settings.shortcuts.items.${id}`)}>
            <button
              type="button"
              className={s.shortcutInput}
              data-recording={recording === id}
              onClick={() => setRecording(id)}
              onBlur={() => setRecording(null)}
              onKeyDown={async (e) => {
                if (recording !== id) return;
                e.preventDefault();
                if (e.key === "Escape") return setRecording(null);
                const combo = comboFromEvent(e);
                if (!combo) return;
                if (id === "toggleWindow" && !(await transport().app.setGlobalShortcut(combo))) {
                  toast({ tone: "warning", title: t("settings.shortcuts.taken") });
                  return;
                }
                setPrefs({ shortcuts: { ...shortcuts, [id]: combo } });
                setRecording(null);
              }}
              aria-label={`${t(`settings.shortcuts.items.${id}`)}: ${shortcuts[id]}`}
            >
              {recording === id ? t("settings.shortcuts.press") : <Kbd combo={shortcuts[id]} />}
            </button>
          </SettingRow>
        ))}
      </div>
      <Button variant="ghost" onClick={() => setPrefs({ shortcuts: DEFAULT_SHORTCUTS })}>
        {t("actions.reset")}
      </Button>
    </>
  );
}

export function SecuritySection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useApp((st) => st.account.user);
  return (
    <div className={s.card}>
      <SettingRow label={t("account.security.twoFactor")} description={user?.mfaEnabled ? t("account.security.twoFactorOn") : t("account.security.twoFactorOff")}>
        <Button size="sm" onClick={() => navigate("/account/security")}>
          {t("actions.change")}
        </Button>
      </SettingRow>
      <SettingRow label={t("account.security.sessions")}>
        <Button size="sm" onClick={() => navigate("/account/security")}>
          {t("actions.details")}
        </Button>
      </SettingRow>
      <SettingRow label={t("settings.security.trustedDevices")} description={t("settings.security.trustedDevicesDesc")}>
        <Button size="sm" onClick={() => navigate("/account/devices")}>
          {t("actions.details")}
        </Button>
      </SettingRow>
      <SettingRow label={t("settings.security.appLock")} description={t("settings.security.appLockDesc")}>
        <Badge tone="outline">{t("common.comingSoon")}</Badge>
      </SettingRow>
    </div>
  );
}

export function PrivacySection() {
  const { t } = useTranslation();
  const items = [
    { id: "analytics", state: "never" },
    { id: "crash", state: "off" },
    { id: "diagnostics", state: "off" },
    { id: "logs", state: "on" },
    { id: "account", state: "on" },
    { id: "connection", state: "never" },
    { id: "traffic", state: "never" },
  ] as const;
  return (
    <>
      <p className={s.intro}>{t("privacy.intro")}</p>
      <div className={s.card} style={{ padding: 0 }}>
        {items.map((it) => (
          <div key={it.id} className={s.privacyItem}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <strong style={{ fontWeight: 600 }}>{t(`privacy.items.${it.id}.name`)}</strong>
              <Badge tone={it.state === "on" ? "accent" : it.state === "never" ? "success" : "neutral"}>{t(`privacy.state.${it.state}`)}</Badge>
            </div>
            <dl className={s.privacyGrid}>
              {(["what", "why", "where", "control"] as const).map((f) => (
                <div key={f} style={{ display: "contents" }}>
                  <dt>{t(`privacy.labels.${f}`)}</dt>
                  <dd>{t(`privacy.items.${it.id}.${f}`)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </>
  );
}

export function AboutSection() {
  const { t } = useTranslation();
  const caps = useApp((st) => st.capabilities);
  const wg = caps?.protocols.find((p) => p.protocol === "wireguard");
  return (
    <div className={s.card}>
      <div className={s.aboutBrand}>
        <Logo size={64} />
        <div>
          <div className={s.aboutName}>{t("app.name")}</div>
          <div className={s.aboutVersion}>{transport().app.version}</div>
        </div>
      </div>
      <SettingRow label={t("settings.about.version")}>
        <span className="mono">{transport().app.version}</span>
      </SettingRow>
      <SettingRow label={t("settings.about.service")}>
        <span className="mono">{caps?.serviceVersion ?? "—"}</span>
      </SettingRow>
      <SettingRow label={t("settings.about.driver")}>
        <span className="mono">{wg?.implementation ?? "—"}</span>
      </SettingRow>
      <SettingRow label={t("settings.about.os")}>
        <span className="mono">{caps ? `${caps.os.family} ${caps.os.version} (${caps.os.arch})` : "—"}</span>
      </SettingRow>
      <SettingRow label={t("settings.about.update")} description={t("settings.about.updateNotConfigured")}>
        <Button size="sm" disabled>
          {t("settings.about.update")}
        </Button>
      </SettingRow>
      <p className={s.note} style={{ padding: "var(--space-4) 0" }}>
        {t("settings.about.wireguard")}
      </p>
    </div>
  );
}
