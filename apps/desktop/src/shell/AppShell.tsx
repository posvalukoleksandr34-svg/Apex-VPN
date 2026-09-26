import {
  Bell,
  LayoutDashboard,
  Layers,
  LifeBuoy,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Server,
  Settings as SettingsIcon,
  ShieldCheck,
  Stethoscope,
  UserRound,
} from "lucide-react";
import { lazy, Suspense, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useNavigate } from "react-router";
import { signOut } from "@/app/actions";
import { Banner, Button, IconButton, Kbd, Menu, MenuItem, MenuSeparator, StatusDot } from "@/design";
import { describe } from "@/features/connection/status";
import { useApp } from "@/state/store";
import s from "./AppShell.module.css";
import { Logo } from "./Logo";
import { NotificationsPanel } from "./NotificationsPanel";
import { SearchPalette } from "./SearchPalette";
import { useGlobalShortcuts } from "./useShortcuts";

const DevPanel = lazy(() => import("@/platform/simulator/DevPanel"));

const NAV = [
  { to: "/", key: "dashboard", icon: LayoutDashboard, end: true },
  { to: "/servers", key: "servers", icon: Server },
  { to: "/profiles", key: "profiles", icon: Layers },
  { to: "/security", key: "security", icon: ShieldCheck },
  { to: "/diagnostics", key: "diagnostics", icon: Stethoscope },
  { to: "/settings", key: "settings", icon: SettingsIcon },
] as const;

export function AppShell({ simulator }: { simulator: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const service = useApp((st) => st.service);
  const tunnel = useApp((st) => st.tunnel);
  const online = useApp((st) => st.online);
  const account = useApp((st) => st.account);
  const unread = useApp((st) => st.notifications.some((n) => !n.read));
  const view = describe(service, tunnel);

  const openSearch = useCallback(() => setSearchOpen(true), []);
  useGlobalShortcuts({ openSearch });

  return (
    <div className={s.shell} data-collapsed={collapsed} data-tone={view.tone}>
      <nav className={s.sidebar} aria-label={t("nav.primary")}>
        <div className={s.brand}>
          <Logo className={s.logo} />
          <span className={s.brandName}>{t("app.name")}</span>
        </div>
        <ul className={s.navList}>
          {NAV.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={"end" in item} className={s.navLink} title={t(`nav.${item.key}`)}>
                <item.icon size={18} aria-hidden />
                <span className={s.label}>{t(`nav.${item.key}`)}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        <div className={s.spacer} />
        <ul className={s.navList}>
          <li>
            <NavLink to="/support" className={s.navLink} title={t("nav.support")}>
              <LifeBuoy size={18} aria-hidden />
              <span className={s.label}>{t("nav.support")}</span>
            </NavLink>
          </li>
          <li>
            <button
              type="button"
              className={`${s.navLink} ${s.navButton}`}
              onClick={() => setCollapsed((c) => !c)}
              aria-label={t(collapsed ? "nav.expand" : "nav.collapse")}
            >
              {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
              <span className={s.label}>{t(collapsed ? "nav.expand" : "nav.collapse")}</span>
            </button>
          </li>
        </ul>
      </nav>

      <div className={s.main}>
        {simulator ? (
          <div className={s.devBanner} role="note">
            {t("dev.banner")}
          </div>
        ) : null}
        <header className={s.header}>
          <NavLink to="/" className={s.statusPill} data-tone={view.tone} aria-live="polite">
            <StatusDot pulse={view.busy} />
            {t(view.title, view.values)}
          </NavLink>
          <button type="button" className={s.searchButton} onClick={() => setSearchOpen(true)} aria-label={t("nav.search")} aria-keyshortcuts="Control+K">
            <Search size={16} aria-hidden />
            <span>{t("search.trigger")}</span>
            <span className={s.kbdHint}>
              <Kbd combo="Ctrl+K" />
            </span>
          </button>
          <div className={s.headerActions}>
            <NotificationsPanel
              trigger={
                // The button itself is the trigger (so it carries
                // aria-expanded and toggles); the unread dot lives inside it.
                <IconButton
                  className={s.bell}
                  label={t("nav.notifications")}
                  tooltip={false}
                  icon={
                    <>
                      <Bell size={18} />
                      {unread ? <span className={s.unread} aria-hidden /> : null}
                    </>
                  }
                />
              }
            />
            {account.status === "signed_in" && account.user ? (
              <Menu
                trigger={
                  <button type="button" className={s.avatar} aria-label={t("nav.account")}>
                    {account.user.email[0]}
                  </button>
                }
              >
                <MenuItem icon={<UserRound size={16} />} onSelect={() => navigate("/account")}>
                  {account.user.email}
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon={<LogOut size={16} />} onSelect={() => void signOut()}>
                  {t("actions.signOut")}
                </MenuItem>
              </Menu>
            ) : account.status === "signed_out" ? (
              <Button size="sm" variant="primary" onClick={() => navigate("/auth/signin")}>
                {t("actions.sign_in")}
              </Button>
            ) : null}
          </div>
        </header>

        <main className={s.content} id="main">
          {(!online || service === "unavailable") && (
            <div className={s.banners}>
              {!online ? <Banner tone="warning">{t("common.offlineBanner")}</Banner> : null}
              {service === "unavailable" ? (
                <Banner tone="error" action={<Button size="sm" onClick={() => navigate("/diagnostics")}>{t("actions.open_diagnostics")}</Button>}>
                  {t("common.serviceBanner")}
                </Banner>
              ) : null}
            </div>
          )}
          <Outlet />
        </main>
      </div>

      <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} />
      {simulator ? (
        <Suspense fallback={null}>
          <DevPanel />
        </Suspense>
      ) : null}
    </div>
  );
}

