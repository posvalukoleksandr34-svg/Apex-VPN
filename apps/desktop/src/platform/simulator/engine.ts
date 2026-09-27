/**
 * DEVELOPMENT SIMULATOR ONLY. Imitates the service's state machine so the UI
 * can be built and tested in a browser. It follows the same state contract
 * (vpn-types) and never produces "connected" without going through the same
 * phases the real service does. Every value it emits is fake; the UI shows a
 * permanent banner while it's active.
 */
import type {
  CheckResult,
  ConnectTarget,
  ConnectPhase,
  DeviceInfo,
  ErrorKind,
  Event,
  LatencySample,
  LeakTestResult,
  LogCategory,
  LogEntry,
  LogLevel,
  NetworkSnapshot,
  ReconnectCause,
  RelayList,
  Settings,
  SettingsPatch,
  TunnelState,
} from "@/protocol";
import type { ServiceStatus } from "../transport";
import { simulatedFleet } from "./fleet";

export function defaultSettings(): Settings {
  return {
    schemaVersion: 1,
    protocol: "automatic",
    killSwitch: "while_connected",
    allowLan: true,
    dns: { mode: "vpn", customServers: [], blockLeaks: true },
    network: {
      enableIpv6: true,
      blockIpv6Leaks: true,
      mtu: null,
      reconnect: { autoReconnect: true, maxAttempts: 0, switchServerAfter: 3 },
      persistentKeepalive: 25,
    },
    splitTunnel: { mode: "off", apps: [] },
    autoConnect: { onSystemStart: false, onUntrustedNetwork: false, onOpenWifi: true, reconnectWhenOnline: true },
    trustedNetworks: [],
    defaultTarget: { kind: "smart", mode: "best_overall", country: null, city: null, features: [] },
    lastTarget: null,
    logging: { level: "info", diagnosticMode: false },
  };
}

export interface SimFlags {
  slowNetwork: boolean;
  failHandshake: boolean;
}

type Listener = (e: Event) => void;

export class SimEngine {
  state: TunnelState = { state: "disconnected", lockedDown: false };
  settings: Settings = defaultSettings();
  relays: RelayList = simulatedFleet(Date.now());
  latencies = new Map<string, LatencySample>();
  device: DeviceInfo = { publicKey: "U2ltdWxhdGVkRGV2aWNlS2V5LU5vdFJlYWwtMDAwMDA=", keyCreatedAt: Date.now() - 86_400_000, registration: null };
  network: NetworkSnapshot = {
    online: true,
    primary: { id: "{SIM-WIFI}", interfaceName: "Wi-Fi (simulated)", medium: "wifi", ssid: "Simulated Home", wifiSecurity: "protected", hasIpv4: true, hasIpv6: false, dnsServers: ["192.0.2.1"], gateway: "192.0.2.1" },
    networks: [],
    observedAt: Date.now(),
  };
  service: ServiceStatus = "ready";
  flags: SimFlags = { slowNetwork: false, failHandshake: false };
  logs: LogEntry[] = [];
  private seq = 1;
  private timers: number[] = [];
  private rx = 0;
  private tx = 0;
  private connectedAt = 0;
  private listeners = new Set<Listener>();
  private serviceListeners = new Set<(s: ServiceStatus) => void>();
  private statsTimer: number | undefined;
  private target: ConnectTarget | null = null;

  constructor() {
    this.network.networks = this.network.primary ? [this.network.primary] : [];
    for (const s of this.relays.servers) {
      const hash = [...s.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
      this.latencies.set(s.id, { serverId: s.id, rttMs: s.status === "maintenance" ? null : 9 + (hash % 180), measuredAt: Date.now(), viaTunnel: false });
    }
    this.log("info", "service", "service.start", "Simulated service started");
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onService(l: (s: ServiceStatus) => void) {
    this.serviceListeners.add(l);
    queueMicrotask(() => l(this.service));
    return () => this.serviceListeners.delete(l);
  }

  private emit(e: Event) {
    this.listeners.forEach((l) => l(e));
  }

  private setState(s: TunnelState) {
    this.state = s;
    this.emit({ kind: "tunnel_state", data: s });
  }

  private log(level: LogLevel, category: LogCategory, event: string, message: string) {
    const entry: LogEntry = { seq: this.seq++, at: Date.now(), level, category, event, message };
    this.logs.push(entry);
    this.emit({ kind: "log", data: entry });
  }

  private later(ms: number, fn: () => void) {
    this.timers.push(window.setTimeout(fn, ms * (this.flags.slowNetwork ? 4 : 1)));
  }

  private clearTimers() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
  }

  private blocking() {
    return this.settings.killSwitch !== "off";
  }

  private pickServer(target: ConnectTarget) {
    if (target.kind === "server") return this.relays.servers.find((s) => s.id === target.id) ?? null;
    const candidates = this.relays.servers
      .filter((s) => s.status === "online" || s.status === "busy")
      .filter((s) => !target.country || this.relays.locations.find((l) => l.id === s.locationId)?.countryCode === target.country)
      .filter((s) => target.features.every((f) => s.features.includes(f)));
    const key = (id: string) => {
      const lat = this.latencies.get(id)?.rttMs ?? 999;
      const load = this.relays.servers.find((s) => s.id === id)?.load ?? 50;
      return target.mode === "lowest_load" ? load : target.mode === "fastest" ? lat : lat * 0.6 + load;
    };
    return candidates.sort((a, b) => key(a.id) - key(b.id))[0] ?? null;
  }

  private summary(target: ConnectTarget) {
    const server = this.pickServer(target);
    if (!server) return null;
    const loc = this.relays.locations.find((l) => l.id === server.locationId)!;
    return { server, loc, relay: { serverId: server.id, hostname: server.hostname, countryCode: loc.countryCode, country: loc.country, city: loc.city, protocol: "wireguard" as const } };
  }

  connect(target: ConnectTarget | null) {
    if (this.service !== "ready") return;
    const t = target ?? this.settings.defaultTarget;
    this.clearTimers();
    this.target = t;
    this.log("info", "connection", "connect.requested", "Connect requested (simulated)");
    if (!this.device.registration) {
      this.setState({ state: "error", error: { kind: "auth_required", detail: "simulated: device not registered", at: Date.now() }, blocking: this.blocking() });
      return;
    }
    this.attempt(t, 1, false);
  }

  private attempt(target: ConnectTarget, attempt: number, reconnecting: boolean, cause: ReconnectCause = "tunnel_failure") {
    const pick = this.summary(target);
    if (!pick) {
      this.setState({ state: "error", error: { kind: "no_matching_server", detail: null, at: Date.now() }, blocking: this.blocking() });
      return;
    }
    const phases: ConnectPhase[] = ["selecting_server", "creating_interface", "configuring_network", "handshaking", "verifying_tunnel"];
    const progress = (phase: ConnectPhase, lastError: ErrorKind | null = null, retryAt: number | null = null) => {
      const common = { target, relay: pick.relay, attempt, phase, blocking: this.blocking(), lastError, retryAt };
      this.setState(reconnecting ? { state: "reconnecting", cause, ...common } : { state: "connecting", ...common });
    };
    phases.forEach((p, i) => this.later(i * 450, () => progress(p)));
    this.later(phases.length * 450 + 300, () => {
      if (this.flags.failHandshake) {
        this.log("warn", "connection", "connect.failed", "Attempt failed: handshake_timeout (simulated)");
        const delay = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
        progress("waiting_to_retry", "handshake_timeout", Date.now() + delay);
        this.later(delay, () => this.attempt(target, attempt + 1, reconnecting, cause));
        return;
      }
      this.connectedAt = reconnecting && this.connectedAt ? this.connectedAt : Date.now();
      this.setConnected(pick);
      this.log("info", "connection", "connect.succeeded", `Connected to ${pick.server.hostname} (simulated)`);
    });
  }

  private setConnected(pick: NonNullable<ReturnType<SimEngine["summary"]>>) {
    const ipv6Tunneled = false;
    this.setState({
      state: "connected",
      details: {
        relay: pick.relay,
        endpoint: `${pick.server.ipv4}:51820`,
        tunnelIpv4: "10.64.13.37",
        tunnelIpv6: null,
        dnsServers: this.settings.dns.mode === "custom" ? this.settings.dns.customServers : ["10.64.0.1"],
        dnsMode: this.settings.dns.mode,
        mtu: this.settings.network.mtu ?? 1420,
        interface: { name: "Apexy VPN", index: 42, luid: 1234567 },
        cipher: { handshake: "Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s", data: "ChaCha20-Poly1305", keyExchange: "Curve25519" },
        connectedAt: this.connectedAt,
        lastHandshake: Date.now(),
        protections: {
          killSwitch: this.settings.killSwitch !== "off",
          dnsLeakBlocking: this.settings.dns.blockLeaks && this.settings.dns.mode !== "system",
          ipv6LeakBlocking: this.settings.network.blockIpv6Leaks && !ipv6Tunneled,
          ipv6Tunneled,
          splitTunnel: this.settings.splitTunnel.mode === "off" ? "inactive" : "not_enforced",
        },
        localPublicKey: this.device.publicKey,
        serverPublicKey: pick.server.wireguard!.publicKey,
      },
    });
    window.clearInterval(this.statsTimer);
    this.statsTimer = window.setInterval(() => {
      this.rx += Math.round(40_000 + Math.random() * 900_000);
      this.tx += Math.round(8_000 + Math.random() * 120_000);
      this.emit({ kind: "stats", data: { rxBytes: this.rx, txBytes: this.tx, lastHandshake: Date.now() - 20_000, sampledAt: Date.now() } });
    }, 1000);
  }

  disconnect() {
    this.clearTimers();
    window.clearInterval(this.statsTimer);
    if (this.state.state === "disconnected") return;
    this.setState({ state: "disconnecting", then: "nothing" });
    this.later(350, () => {
      this.connectedAt = 0;
      this.target = null;
      this.setState({ state: "disconnected", lockedDown: this.settings.killSwitch === "always_on" });
      this.log("info", "connection", "disconnect", "Disconnected (simulated)");
    });
  }

  reconnect() {
    if (this.state.state === "error" || this.state.state === "connected") this.connect(this.target);
  }

  updateSettings(patch: Partial<SettingsPatch>) {
    const next: Settings = { ...this.settings };
    for (const [k, v] of Object.entries(patch)) if (v !== null && v !== undefined) (next as Record<string, unknown>)[k] = v;
    const mtu = next.network.mtu;
    if (mtu !== null && (mtu < 1280 || mtu > 1500)) throw new Error("network.mtu: must be between 1280 and 1500");
    this.settings = next;
    this.emit({ kind: "settings", data: next });
    if (this.state.state === "disconnected") this.setState({ state: "disconnected", lockedDown: next.killSwitch === "always_on" });
    return next;
  }

  // ── developer controls ────────────────────────────────────────────────

  dropNetwork() {
    this.network = { ...this.network, online: false, primary: null, observedAt: Date.now() };
    this.emit({ kind: "network", data: this.network });
    this.log("info", "network", "network.offline", "Network connectivity lost (simulated)");
    if (this.state.state !== "disconnected" && this.state.state !== "error") {
      this.clearTimers();
      window.clearInterval(this.statsTimer);
      this.setState({ state: "waiting_for_network", target: this.target, blocking: this.blocking() });
    }
  }

  restoreNetwork(ssid = "Simulated Home") {
    const primary = { id: `{SIM-${ssid}}`, interfaceName: "Wi-Fi (simulated)", medium: "wifi" as const, ssid, wifiSecurity: "protected" as const, hasIpv4: true, hasIpv6: false, dnsServers: ["192.0.2.1"], gateway: "192.0.2.1" };
    this.network = { online: true, primary, networks: [primary], observedAt: Date.now() };
    this.emit({ kind: "network", data: this.network });
    this.log("info", "network", "network.online", "Network connectivity restored (simulated)");
    if (this.state.state === "waiting_for_network" && this.target) this.attempt(this.target, 1, true, "network_restored");
  }

  networkChange() {
    this.restoreNetwork("Phone hotspot");
    if (this.state.state === "connected" && this.target) {
      const pick = this.summary(this.target)!;
      this.setState({ state: "reconnecting", target: this.target, relay: pick.relay, attempt: 0, cause: "network_changed", phase: "checking_tunnel", blocking: this.blocking(), lastError: null, retryAt: null });
      this.later(1200, () => this.setConnected(pick));
    }
  }

  sleepWake() {
    if (this.state.state === "connected" && this.target) {
      const pick = this.summary(this.target)!;
      this.log("info", "network", "power.resume", "System woke up (simulated)");
      this.setState({ state: "reconnecting", target: this.target, relay: pick.relay, attempt: 0, cause: "woke_from_sleep", phase: "checking_tunnel", blocking: this.blocking(), lastError: null, retryAt: null });
      this.later(1500, () => this.setConnected(pick));
    }
  }

  setService(s: ServiceStatus) {
    this.service = s;
    this.serviceListeners.forEach((l) => l(s));
  }

  injectError(kind: ErrorKind) {
    this.clearTimers();
    window.clearInterval(this.statsTimer);
    this.log("error", "connection", "connect.error", `Connection failed: ${kind} (simulated)`);
    this.setState({ state: "error", error: { kind, detail: "simulated failure", at: Date.now() }, blocking: this.blocking() });
  }

  // ── read models ───────────────────────────────────────────────────────

  diagnostics(): CheckResult[] {
    const connected = this.state.state === "connected";
    const mk = (id: CheckResult["id"], status: CheckResult["status"], finding: string): CheckResult => ({ id, status, finding, evidence: { simulated: true }, durationMs: 120 });
    return [
      mk("internet", this.network.online ? "working" : "failed", this.network.online ? "online" : "no_network"),
      mk("dns", this.network.online ? "working" : "failed", this.network.online ? "resolving" : "resolvers_not_answering"),
      mk("service", "working", "running"),
      mk("server_reachability", "working", "reachable"),
      mk("tunnel", connected ? "working" : "skipped", connected ? "handshake_fresh" : "not_connected"),
      mk("routing", connected ? "working" : "skipped", connected ? "default_route_via_tunnel" : "not_connected"),
      mk("kill_switch", this.settings.killSwitch === "off" ? "warning" : "working", this.settings.killSwitch === "off" ? "kill_switch_off" : "active"),
      mk("ipv6", connected ? "working" : "skipped", connected ? "no_ipv6_on_network" : "not_connected"),
    ];
  }

  leakTests(): LeakTestResult[] {
    const now = Date.now();
    if (this.state.state !== "connected") {
      return (["ipv4", "ipv6", "dns"] as const).map((test) => ({ test, verdict: "unable_to_verify", finding: "not_connected", observed: [], expected: [], testedAt: now }));
    }
    const ip = this.state.details.endpoint.split(":")[0]!;
    return [
      { test: "ipv4", verdict: "protected", finding: "exit_is_vpn_server", observed: [ip], expected: [ip], testedAt: now },
      { test: "ipv6", verdict: "protected", finding: "no_ipv6_on_network", observed: [], expected: [], testedAt: now },
      { test: "dns", verdict: "protected", finding: "dns_only_via_tunnel", observed: ["10.64.0.1"], expected: ["10.64.0.1"], testedAt: now },
    ];
  }
}
