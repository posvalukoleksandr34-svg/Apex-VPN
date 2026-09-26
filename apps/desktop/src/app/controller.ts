/**
 * Wires the transport to the store: initial load, service events, account
 * session, OS notifications and the tray. Runs once at startup.
 */
import i18n, { resolveLanguage } from "@/i18n";
import type { Event, TunnelState } from "@/protocol";
import type { ClientTransport, ServiceStatus } from "@/platform/transport";
import { describe } from "@/features/connection/status";
import { clearTunnelData, useApp } from "@/state/store";
import { ensureEnrolled, refreshSubscription } from "./actions";
import { setTransport, transport } from "./transportRef";

export function startController(t: ClientTransport): () => void {
  setTransport(t);
  const offs: (() => void)[] = [];

  offs.push(t.onServiceStatus((status) => onServiceStatus(t, status)));
  offs.push(t.onEvent((e) => onEvent(e)));
  offs.push(t.account.onSessionChange((user) => onSession(user)));
  offs.push(applyPrefsToDocument());

  void t.account.session().then(onSession, () => useApp.setState((s) => ({ account: { ...s.account, status: "signed_out" } })));

  const online = () => useApp.setState({ online: navigator.onLine });
  window.addEventListener("online", online);
  window.addEventListener("offline", online);
  offs.push(() => {
    window.removeEventListener("online", online);
    window.removeEventListener("offline", online);
  });

  // Coming back to the window is when a purchase in the browser (checkout or
  // billing portal) has most likely just finished: refresh then.
  let lastFocusRefresh = 0;
  const onFocus = () => {
    if (useApp.getState().account.status !== "signed_in" || Date.now() - lastFocusRefresh < 15_000) return;
    lastFocusRefresh = Date.now();
    void refreshSubscription();
  };
  window.addEventListener("focus", onFocus);
  offs.push(() => window.removeEventListener("focus", onFocus));

  // Subscription state changes rarely; refresh it now and then.
  const timer = window.setInterval(() => {
    if (useApp.getState().account.status === "signed_in") void refreshSubscription();
  }, 10 * 60_000);
  offs.push(() => clearInterval(timer));

  // Tray mirrors the same status model as the window, in the UI's language.
  const pushTray = () => {
    const s = useApp.getState();
    const view = describe(s.service, s.tunnel);
    void t.app.setTray({
      tone: view.tone,
      label: i18n.t(view.title, view.values),
      canConnect: view.primary === "connect" || view.primary === "retry",
      canDisconnect: !!s.tunnel && s.tunnel.state !== "disconnected",
      menu: { show: i18n.t("tray.show"), connect: i18n.t("actions.connect"), disconnect: i18n.t("actions.disconnect"), quit: i18n.t("tray.quit") },
    });
  };
  offs.push(
    useApp.subscribe((s, prev) => {
      if (s.tunnel !== prev.tunnel || s.service !== prev.service) pushTray();
      if (s.prefs.closeToTray !== prev.prefs.closeToTray) void t.app.setCloseToTray(s.prefs.closeToTray);
    }),
  );
  i18n.on("languageChanged", pushTray);
  offs.push(() => i18n.off("languageChanged", pushTray));
  pushTray();
  // The core starts with the default; tell it the saved choice.
  void t.app.setCloseToTray(useApp.getState().prefs.closeToTray);
  return () => offs.forEach((f) => f());
}

async function onServiceStatus(t: ClientTransport, status: ServiceStatus) {
  useApp.setState({ service: status });
  if (status !== "ready") return;
  try {
    const [tunnel, settings, capabilities, relayReply, latencies, device, network, ip, logs] = await Promise.all([
      t.call("get_state"),
      t.call("get_settings"),
      t.call("get_capabilities"),
      t.call("get_relay_list"),
      t.call("get_latencies"),
      t.call("get_device"),
      t.call("get_network"),
      t.call("get_ip_observations"),
      t.call("get_logs", { query: { afterSeq: null, minLevel: null, category: null, limit: 1000 } }),
    ]);
    useApp.setState({
      tunnel,
      settings,
      capabilities,
      serviceVersion: capabilities.serviceVersion,
      relays: relayReply.list,
      relayStatus: relayReply.status,
      latencies: Object.fromEntries(latencies.map((l) => [l.serverId, l])),
      device,
      network,
      ip,
    });
    useApp.getState().pushLogs(logs);
  } catch {
    // The status stream reports the service as unavailable if it's gone.
  }
}

let lastState: TunnelState | null = null;

function onEvent(e: Event) {
  const store = useApp.getState();
  switch (e.kind) {
    case "tunnel_state": {
      const prev = lastState;
      lastState = e.data;
      useApp.setState({ tunnel: e.data });
      if (e.data.state !== "connected") clearTunnelData();
      onTransition(prev, e.data);
      break;
    }
    case "stats":
      store.pushStats(e.data);
      break;
    case "settings":
      useApp.setState({ settings: e.data });
      break;
    case "relay_list": {
      const changed = e.data.version !== store.relayStatus?.version;
      useApp.setState({ relayStatus: e.data });
      if (changed) {
        void transport()
          .call("get_relay_list")
          .then((r) => useApp.setState({ relays: r.list, relayStatus: r.status }));
      }
      break;
    }
    case "latencies": {
      const latencies = { ...store.latencies };
      for (const l of e.data) latencies[l.serverId] = l;
      useApp.setState({ latencies });
      break;
    }
    case "network":
      useApp.setState({ network: e.data });
      break;
    case "device":
      useApp.setState({ device: e.data });
      break;
    case "log":
      store.pushLogs([e.data]);
      break;
  }
}

/** OS notifications and recents, on real transitions only. */
function onTransition(prev: TunnelState | null, next: TunnelState) {
  const { prefs, setPrefs, addNotification } = useApp.getState();
  if (!prev) return;
  const notify = (title: string, body: string, type: string) => {
    addNotification({ id: `local-${Date.now()}`, type, title, body, createdAt: Date.now(), source: "local" });
    void transport().app.notify(title, body);
  };
  if (next.state === "connected" && prev.state !== "connected") {
    const r = next.details.relay;
    const recents = [{ serverId: r.serverId, at: Date.now() }, ...prefs.recents.filter((x) => x.serverId !== r.serverId)].slice(0, 12);
    setPrefs({ recents });
    // The service checks the exit address through the tunnel right after
    // connecting; pick up its observation once it has had time to run.
    window.setTimeout(() => {
      void transport()
        .call("get_ip_observations")
        .then((ip) => useApp.setState({ ip }), () => {});
    }, 3500);
    if (prefs.notify.connected) notify(i18n.t("app.name"), i18n.t("osNotify.connected", { city: r.city, country: r.country }), "connected");
  }
  if (next.state === "disconnected" && prev.state !== "disconnected" && prefs.notify.disconnected) {
    notify(i18n.t("app.name"), i18n.t("osNotify.disconnected"), "disconnected");
  }
  if (next.state === "error" && prev.state !== "error") {
    if (prefs.notify.connectionFailed) notify(i18n.t("app.name"), i18n.t("osNotify.failed", { reason: i18n.t(`errors.${next.error.kind}.title`) }), "failed");
  }
  const blockingNow = (next.state === "error" || next.state === "waiting_for_network") && next.blocking;
  const blockingBefore = prev.state === next.state && "blocking" in prev && prev.blocking;
  if (blockingNow && !blockingBefore && prefs.notify.killSwitch) {
    notify(i18n.t("app.name"), i18n.t("osNotify.killSwitch"), "kill_switch");
  }
}

async function onSession(user: Parameters<Parameters<ClientTransport["account"]["onSessionChange"]>[0]>[0]) {
  useApp.setState((s) => ({ account: { ...s.account, status: user ? "signed_in" : "signed_out", user } }));
  if (!user) return;
  await refreshSubscription();
  if (user.emailVerified) await ensureEnrolled().catch(() => {});
}

/** Theme, density, motion, text size and language follow the preferences. */
function applyPrefsToDocument(): () => void {
  const root = document.documentElement;
  const media = window.matchMedia?.("(prefers-color-scheme: light)");
  const apply = () => {
    const { prefs } = useApp.getState();
    const theme = prefs.theme === "system" ? (media?.matches ? "light" : "dark") : prefs.theme;
    root.dataset.theme = theme;
    root.dataset.density = prefs.density;
    if (prefs.motion === "system") delete root.dataset.motion;
    else root.dataset.motion = prefs.motion;
    root.style.setProperty("--text-scale", String(prefs.textScale));
    const lang = resolveLanguage(prefs.language);
    if (i18n.language !== lang) void i18n.changeLanguage(lang);
    root.lang = lang;
  };
  apply();
  const off = useApp.subscribe((s, prev) => {
    if (s.prefs !== prev.prefs) apply();
  });
  media?.addEventListener?.("change", apply);
  return () => {
    off();
    media?.removeEventListener?.("change", apply);
  };
}
