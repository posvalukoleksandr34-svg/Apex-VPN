import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, NavLink, useNavigate, useParams } from "react-router";
import { Banner, Button, Page, PageHeader } from "@/design";
import { useApp } from "@/state/store";
import { AboutSection, AppearanceSection, GeneralSection, NotificationsSection, PrivacySection, SecuritySection, ShortcutsSection } from "./AppSections";
import { ConnectionSection, DnsSection, KillSwitchSection, ProtocolsSection } from "./ConnectionSections";
import { AdvancedSection, AutoConnectSection, NetworkSection, SplitTunnelingSection } from "./NetworkSections";
import s from "./Settings.module.css";

type SectionId =
  | "general"
  | "appearance"
  | "connection"
  | "protocols"
  | "killSwitch"
  | "dns"
  | "splitTunneling"
  | "network"
  | "autoConnect"
  | "security"
  | "privacy"
  | "notifications"
  | "shortcuts"
  | "account"
  | "subscription"
  | "diagnostics"
  | "advanced"
  | "about";

const SECTIONS: Record<SectionId, ComponentType | { link: string }> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  connection: ConnectionSection,
  protocols: ProtocolsSection,
  killSwitch: KillSwitchSection,
  dns: DnsSection,
  splitTunneling: SplitTunnelingSection,
  network: NetworkSection,
  autoConnect: AutoConnectSection,
  security: SecuritySection,
  privacy: PrivacySection,
  notifications: NotificationsSection,
  shortcuts: ShortcutsSection,
  account: { link: "/account" },
  subscription: { link: "/account/subscription" },
  diagnostics: { link: "/diagnostics" },
  advanced: AdvancedSection,
  about: AboutSection,
};

const GROUPS: { label: string; items: SectionId[] }[] = [
  { label: "app", items: ["general", "appearance", "notifications", "shortcuts"] },
  { label: "vpn", items: ["connection", "protocols", "killSwitch", "dns", "splitTunneling", "network", "autoConnect"] },
  { label: "you", items: ["security", "privacy", "account", "subscription"] },
  { label: "more", items: ["diagnostics", "advanced", "about"] },
];

/** Sections whose values live in the VPN service (not the app). */
const SERVICE_SECTIONS: SectionId[] = ["connection", "protocols", "killSwitch", "dns", "splitTunneling", "network", "autoConnect", "advanced"];

export default function Settings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { section = "general" } = useParams<{ section: SectionId }>();
  const service = useApp((st) => st.service);
  const settings = useApp((st) => st.settings);
  if (!(section in SECTIONS)) return <Navigate to="/settings/general" replace />;
  const entry = SECTIONS[section as SectionId];
  const needsService = SERVICE_SECTIONS.includes(section as SectionId);

  return (
    <Page>
      <PageHeader title={t("settings.title")} />
      <div className={s.layout}>
        <nav className={s.nav} aria-label={t("settings.title")}>
          {GROUPS.map((g) => (
            <div key={g.label} style={{ display: "contents" }}>
              <div className={s.navGroup} aria-hidden>
                {t(`settings.groups.${g.label}`)}
              </div>
              {g.items.map((id) => (
                <NavLink key={id} to={`/settings/${id}`} className={s.navItem}>
                  {t(`settings.sections.${id}`)}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <section className={s.panel} aria-labelledby="settings-section-title">
          <h2 id="settings-section-title" className={s.panelTitle}>
            {t(`settings.sections.${section}`)}
          </h2>
          {needsService ? <p className={s.note} style={{ marginBottom: "var(--space-4)" }}>{t("settings.serviceOnly")}</p> : null}
          {needsService && (service !== "ready" || !settings) ? (
            <Banner tone="error">{t("common.serviceBanner")}</Banner>
          ) : "link" in entry ? (
            <Button variant="primary" onClick={() => navigate(entry.link)}>
              {t(`settings.sections.${section}`)}
            </Button>
          ) : (
            (() => {
              const C = entry;
              return <C />;
            })()
          )}
        </section>
      </div>
    </Page>
  );
}
