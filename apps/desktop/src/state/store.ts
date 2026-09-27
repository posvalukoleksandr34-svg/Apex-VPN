import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type {
  Capabilities,
  DeviceInfo,
  IpObservations,
  LatencySample,
  LogEntry,
  NetworkSnapshot,
  RelayList,
  RelayListStatus,
  Settings,
  TunnelState,
  TunnelStats,
} from "@/protocol";
import type { ServiceStatus, User } from "@/platform/transport";
import { DEFAULT_PREFS, type UiPrefs } from "./types";

export interface Subscription {
  status: "none" | "incomplete" | "trialing" | "active" | "past_due" | "canceled" | "expired";
  plan: { id: string; name: string; period: string; priceCents: number; currency: string; deviceLimit: number } | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  provider: string | null;
  paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null;
  devicesUsed: number;
}

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  createdAt: number;
  read: boolean;
  source: "account" | "local";
}

export interface Rates {
  rx: number | null;
  tx: number | null;
  history: { at: number; rx: number; tx: number }[];
}

export interface AppState {
  service: ServiceStatus;
  serviceVersion: string | null;
  tunnel: TunnelState | null;
  stats: TunnelStats | null;
  rates: Rates;
  settings: Settings | null;
  capabilities: Capabilities | null;
  relays: RelayList | null;
  relayStatus: RelayListStatus | null;
  latencies: Record<string, LatencySample>;
  device: DeviceInfo | null;
  network: NetworkSnapshot | null;
  ip: IpObservations | null;
  logs: LogEntry[];
  account: { status: "unknown" | "signed_out" | "signed_in"; user: User | null; subscription: Subscription | null; offline: boolean };
  notifications: AppNotification[];
  prefs: UiPrefs;
  online: boolean;

  setPrefs(patch: Partial<UiPrefs>): void;
  pushStats(stats: TunnelStats): void;
  pushLogs(entries: LogEntry[]): void;
  addNotification(n: Omit<AppNotification, "read">): void;
}

const MAX_LOGS = 2000;
const RATE_WINDOW = 60;

/** localStorage can throw (private mode, blocked storage); the app still works. */
const safeStorage = createJSONStorage(() => ({
  getItem: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* not persisted this time */
    }
  },
  removeItem: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
}));

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      service: "connecting",
      serviceVersion: null,
      tunnel: null,
      stats: null,
      rates: { rx: null, tx: null, history: [] },
      settings: null,
      capabilities: null,
      relays: null,
      relayStatus: null,
      latencies: {},
      device: null,
      network: null,
      ip: null,
      logs: [],
      account: { status: "unknown", user: null, subscription: null, offline: false },
      notifications: [],
      prefs: DEFAULT_PREFS,
      online: typeof navigator === "undefined" ? true : navigator.onLine,

      setPrefs: (patch) => set({ prefs: { ...get().prefs, ...patch } }),

      // Speeds come only from two consecutive driver counter samples.
      pushStats: (stats) => {
        const prev = get().stats;
        let { rx, tx, history } = get().rates;
        if (prev && stats.sampledAt > prev.sampledAt && stats.rxBytes >= prev.rxBytes && stats.txBytes >= prev.txBytes) {
          const dt = (stats.sampledAt - prev.sampledAt) / 1000;
          rx = (stats.rxBytes - prev.rxBytes) / dt;
          tx = (stats.txBytes - prev.txBytes) / dt;
          history = [...history, { at: stats.sampledAt, rx, tx }].slice(-RATE_WINDOW);
        }
        set({ stats, rates: { rx, tx, history } });
      },

      pushLogs: (entries) => {
        if (!entries.length) return;
        const seen = new Set(get().logs.map((l) => l.seq));
        const merged = [...get().logs, ...entries.filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq);
        set({ logs: merged.slice(-MAX_LOGS) });
      },

      addNotification: (n) =>
        set({ notifications: [{ ...n, read: false }, ...get().notifications.filter((x) => x.id !== n.id)].slice(0, 200) }),
    }),
    {
      name: "apexy.prefs.v1",
      storage: safeStorage,
      partialize: (s) => ({ prefs: s.prefs }),
      merge: (persisted, current) => {
        const p = (persisted as { prefs?: Partial<UiPrefs> } | undefined)?.prefs ?? {};
        return {
          ...current,
          prefs: {
            ...DEFAULT_PREFS,
            ...p,
            notify: { ...DEFAULT_PREFS.notify, ...(p.notify ?? {}) },
            shortcuts: { ...DEFAULT_PREFS.shortcuts, ...(p.shortcuts ?? {}) },
          },
        };
      },
    },
  ),
);

/** Resets tunnel-derived data when the tunnel goes away (no stale speeds). */
export function clearTunnelData(): void {
  useApp.setState({ stats: null, rates: { rx: null, tx: null, history: [] } });
}
