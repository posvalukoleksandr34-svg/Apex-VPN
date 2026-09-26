/** Settings sections, in navigation order, with search keywords. */
export const SETTINGS_SECTIONS = [
  { id: "general", keywords: ["language", "startup", "tray", "updates", "sprache", "язык", "lingua"] },
  { id: "appearance", keywords: ["theme", "dark", "light", "density", "animation", "motion", "text size"] },
  { id: "connection", keywords: ["reconnect", "default", "smart connect", "server"] },
  { id: "protocols", keywords: ["wireguard", "openvpn", "ikev2", "ipsec", "automatic"] },
  { id: "killSwitch", keywords: ["kill switch", "firewall", "block", "leak", "always on"] },
  { id: "dns", keywords: ["dns", "resolver", "leak", "custom"] },
  { id: "splitTunneling", keywords: ["split", "apps", "exclude", "bypass"] },
  { id: "network", keywords: ["ipv6", "ipv4", "mtu", "lan", "local network", "nat", "keepalive"] },
  { id: "autoConnect", keywords: ["auto", "trusted", "wifi", "wi-fi", "ssid", "public", "home", "work"] },
  { id: "security", keywords: ["2fa", "two-factor", "password", "sessions", "lock"] },
  { id: "privacy", keywords: ["privacy", "data", "analytics", "telemetry", "logs", "collected"] },
  { id: "notifications", keywords: ["notifications", "alerts"] },
  { id: "shortcuts", keywords: ["keyboard", "shortcuts", "hotkeys"] },
  { id: "advanced", keywords: ["advanced", "log level", "diagnostic mode", "key", "reset"] },
  { id: "about", keywords: ["version", "about", "licenses", "update"] },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
