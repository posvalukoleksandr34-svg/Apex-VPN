import type { ConnectTarget, SettingsPatch } from "@/protocol";

export type ThemePref = "dark" | "light" | "system";
export type Language = "system" | "en" | "ru" | "de" | "it";
export type ProfileKind = "gaming" | "streaming" | "work" | "privacy" | "travel" | "custom";

export interface Profile {
  id: string;
  name: string;
  kind: ProfileKind;
  target: ConnectTarget;
  /** Service settings applied before connecting. */
  overrides: Partial<SettingsPatch>;
  /** Connect automatically when the app starts with this profile active. */
  connectOnLaunch: boolean;
}

export type ShortcutId = "toggleConnection" | "disconnect" | "openServers" | "search" | "openSettings" | "toggleWindow";

export type WidgetId = "ip" | "quality" | "session" | "protocol" | "security" | "quickActions" | "recent";

export interface NotifyPrefs {
  connected: boolean;
  disconnected: boolean;
  connectionFailed: boolean;
  killSwitch: boolean;
  security: boolean;
  updates: boolean;
}

/** UI-only preferences, kept on this device. Service settings live in the service. */
export interface UiPrefs {
  theme: ThemePref;
  density: "comfortable" | "compact";
  motion: "system" | "reduced" | "full";
  textScale: number;
  language: Language;
  favorites: string[];
  recents: { serverId: string; at: number }[];
  profiles: Profile[];
  activeProfileId: string | null;
  closeToTray: boolean;
  confirmDisconnect: boolean;
  notify: NotifyPrefs;
  onboardingDone: boolean;
  shortcuts: Record<ShortcutId, string>;
  widgets: WidgetId[];
  showAdvanced: boolean;
}

export const DEFAULT_SHORTCUTS: Record<ShortcutId, string> = {
  toggleConnection: "Ctrl+Shift+C",
  disconnect: "Ctrl+Shift+D",
  openServers: "Ctrl+L",
  search: "Ctrl+K",
  openSettings: "Ctrl+,",
  toggleWindow: "Ctrl+Alt+M",
};

export const DEFAULT_PREFS: UiPrefs = {
  theme: "dark",
  density: "comfortable",
  motion: "system",
  textScale: 1,
  language: "system",
  favorites: [],
  recents: [],
  profiles: [],
  activeProfileId: null,
  closeToTray: true,
  confirmDisconnect: false,
  notify: { connected: true, disconnected: true, connectionFailed: true, killSwitch: true, security: true, updates: true },
  onboardingDone: false,
  shortcuts: DEFAULT_SHORTCUTS,
  widgets: ["ip", "quality", "session", "protocol", "security", "quickActions", "recent"],
  showAdvanced: false,
};
