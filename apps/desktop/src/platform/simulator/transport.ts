/**
 * DEVELOPMENT SIMULATOR ONLY: a ClientTransport backed by `SimEngine` and a
 * simulated account. Excluded from production bundles (see platform/index).
 */
import type { Method, ParamsOf, ResultMap, ResultOf } from "@/protocol";
import { ApiFailure, type ClientTransport, type User } from "../transport";
import { SimEngine } from "./engine";

export const engine = new SimEngine();

type SubStatus = "trialing" | "active" | "past_due" | "canceled" | "expired" | "none";

export const simAccount = {
  user: null as User | null,
  subscription: "trialing" as SubStatus,
  listeners: new Set<(u: User | null) => void>(),
  setUser(u: User | null) {
    this.user = u;
    this.listeners.forEach((l) => l(u));
  },
};

const delay = (ms = 250) => new Promise<void>((r) => setTimeout(r, ms * (engine.flags.slowNetwork ? 4 : 1)));

async function handle<M extends Method>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
  await delay(60);
  if (engine.service !== "ready") throw new Error("service unavailable (simulated)");
  const p = params as Record<string, unknown> | undefined;
  const r = <K extends keyof ResultMap>(v: ResultMap[K]) => v as unknown as ResultOf<M>;
  switch (method) {
    case "get_state":
      return r<"get_state">(engine.state);
    case "connect":
      engine.connect((p?.target as never) ?? null);
      return r<"connect">(null);
    case "disconnect":
      engine.disconnect();
      return r<"disconnect">(null);
    case "reconnect":
      engine.reconnect();
      return r<"reconnect">(null);
    case "get_settings":
      return r<"get_settings">(engine.settings);
    case "update_settings":
      return r<"update_settings">(engine.updateSettings(p!.patch as never));
    case "reset_settings":
      return r<"reset_settings">(engine.updateSettings((await import("./engine")).defaultSettings()));
    case "get_capabilities":
      return r<"get_capabilities">({
        serviceVersion: "0.1.0-sim",
        apiBaseUrl: "https://api.sim.invalid",
        os: { family: "windows", version: "simulated", arch: "x86_64" },
        protocols: [
          { protocol: "wireguard", availability: { status: "available" }, implementation: "Simulated" },
          { protocol: "openvpn", availability: { status: "unavailable", reason: "not_bundled" }, implementation: null },
          { protocol: "ikev2", availability: { status: "unavailable", reason: "not_bundled" }, implementation: null },
        ],
        killSwitch: { status: "available" },
        splitTunnel: { status: "unavailable", reason: "driver_missing" },
        wifiDetection: { status: "available" },
        ipv6: { status: "available" },
        simulated: true,
      });
    case "get_relay_list":
      return r<"get_relay_list">({
        status: { version: engine.relays.version, fetchedAt: Date.now() - 120_000, expiresAt: engine.relays.expiresAt, stale: false, lastError: null },
        list: engine.relays,
      });
    case "refresh_relay_list":
      return r<"refresh_relay_list">({ version: engine.relays.version, fetchedAt: Date.now(), expiresAt: engine.relays.expiresAt, stale: false, lastError: null });
    case "get_latencies":
    case "measure_latencies":
      if (method === "measure_latencies") await delay(900);
      return r<"get_latencies">([...engine.latencies.values()]);
    case "get_device":
      return r<"get_device">(engine.device);
    case "set_device_registration":
      engine.device = { ...engine.device, registration: p!.registration as never };
      return r<"set_device_registration">(engine.device);
    case "clear_device_registration":
      engine.device = { ...engine.device, registration: null };
      return r<"clear_device_registration">(engine.device);
    case "rotate_device_key":
      engine.device = { publicKey: "Um90YXRlZFNpbXVsYXRlZEtleS1Ob3RSZWFsLTAwMDA=", keyCreatedAt: Date.now(), registration: null };
      return r<"rotate_device_key">(engine.device);
    case "get_stats":
      return r<"get_stats">(null);
    case "get_connection_report":
      return r<"get_connection_report">({
        state: engine.state,
        stats: null,
        firewall: { policy: engine.state.state === "connected" ? "block-all,allow-peer,allow-tunnel,dns-via-tunnel(1)" : "open", verified: true, filterCount: engine.state.state === "connected" ? 22 : 0 },
        effectiveDns: engine.state.state === "connected" ? engine.state.details.dnsServers : [],
        routes: engine.state.state === "connected" ? [{ destination: "0.0.0.0/0", interface: "Apexy VPN", metric: 0 }] : [],
      });
    case "get_network":
      return r<"get_network">(engine.network);
    case "check_ip": {
      const connected = engine.state.state === "connected";
      await delay(500);
      return r<"check_ip">({
        ip: connected ? engine.state.state === "connected" ? engine.state.details.endpoint.split(":")[0]! : "" : "198.51.100.23",
        countryCode: null,
        country: null,
        city: null,
        timezone: null,
        asn: null,
        organization: null,
        latitude: null,
        longitude: null,
        observedAt: Date.now(),
        viaTunnel: connected,
      });
    }
    case "get_ip_observations":
      return r<"get_ip_observations">({
        unprotected: { ip: "198.51.100.23", countryCode: null, country: null, city: null, timezone: null, asn: null, organization: null, latitude: null, longitude: null, observedAt: Date.now() - 3_600_000, viaTunnel: false },
        protected: null,
      });
    case "run_leak_tests":
      await delay(1200);
      return r<"run_leak_tests">(engine.leakTests());
    case "test_dns":
      await delay(400);
      return r<"test_dns">([{ server: engine.state.state === "connected" ? "10.64.0.1" : "192.0.2.1", query: "example.com", ok: true, rttMs: 21, outcome: "NOERROR", answers: ["192.0.2.80"] }]);
    case "run_diagnostics":
      await delay(1500);
      return r<"run_diagnostics">(engine.diagnostics());
    case "get_logs":
      return r<"get_logs">(engine.logs.slice(-500));
    case "export_logs":
      return r<"export_logs">("Simulated log\n" + engine.logs.map((l) => `${new Date(l.at).toISOString()} ${l.level} ${l.event} ${l.message}`).join("\n"));
    case "clear_logs":
      engine.logs = [];
      return r<"clear_logs">(null);
    default:
      return r<"subscribe">(null);
  }
}

function subscriptionDto() {
  const now = Date.now();
  const s = simAccount.subscription;
  return {
    status: s,
    plan: s === "none" ? null : { id: s === "trialing" ? "trial" : "monthly", name: s === "trialing" ? "Free trial" : "Monthly", period: s === "trialing" ? "trial" : "month", priceCents: s === "trialing" ? 0 : 999, currency: "EUR", deviceLimit: s === "trialing" ? 2 : 10 },
    currentPeriodStart: new Date(now - 2 * 86_400_000).toISOString(),
    currentPeriodEnd: new Date(now + (s === "expired" ? -86_400_000 : 5 * 86_400_000)).toISOString(),
    cancelAtPeriodEnd: s === "canceled",
    provider: "manual",
    paymentMethod: null,
    devicesUsed: 1,
  };
}

export function createSimulatorTransport(): ClientTransport {
  const apiError = () => {
    if (engine.flags.slowNetwork && Math.random() < 0.1) throw new ApiFailure("network", 0);
  };
  return {
    kind: "simulator",
    call: ((method: Method, params?: unknown) => handle(method, params as never)) as ClientTransport["call"],
    onEvent: (cb) => engine.on(cb),
    onServiceStatus: (cb) => engine.onService(cb),
    reconnectService: async () => engine.setService(engine.service),
    account: {
      session: async () => simAccount.user,
      register: async () => {
        await delay();
        apiError();
      },
      verifyEmail: async (_email, code) => {
        await delay();
        if (code !== "123456") throw new ApiFailure("invalid_code", 400);
      },
      resendVerification: async () => delay(),
      login: async (email) => {
        await delay(500);
        apiError();
        const user: User = { id: "sim-user", email, emailVerified: true, locale: "en", mfaEnabled: false, createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString() };
        simAccount.setUser(user);
        return { kind: "signed_in", user };
      },
      loginMfa: async () => simAccount.user!,
      logout: async () => simAccount.setUser(null),
      forgotPassword: async () => delay(),
      resetPassword: async () => delay(),
      request: async <T,>(method: string, path: string): Promise<T> => {
        await delay();
        apiError();
        if (path === "/v1/subscription") return subscriptionDto() as T;
        if (path === "/v1/subscription/plans") return [
          { id: "monthly", name: "Monthly", period: "month", priceCents: 999, currency: "EUR", deviceLimit: 10 },
          { id: "annual", name: "Annual", period: "year", priceCents: 5999, currency: "EUR", deviceLimit: 10 },
        ] as T;
        if (path === "/v1/subscription/invoices") return [] as T;
        if (path === "/v1/devices") return [
          { id: "sim-device", name: "This PC (simulated)", platform: "windows", appVersion: "0.1.0", publicKey: engine.device.publicKey, ipv4Address: "10.64.13.37", ipv6Address: null, createdAt: new Date().toISOString(), lastSeenOn: new Date().toISOString().slice(0, 10), connected: engine.state.state === "connected", connectedServerId: null },
        ] as T;
        if (path === "/v1/users/me/sessions") return [{ id: "sim-session", deviceName: "This PC (simulated)", platform: "windows", createdAt: new Date().toISOString(), lastUsedOn: new Date().toISOString().slice(0, 10), current: true }] as T;
        if (path === "/v1/notifications") return [] as T;
        if (path === "/v1/notifications/preferences") return { connected: true, disconnected: true, connectionFailed: true, killSwitch: true, newLogin: true, subscription: true, security: true, updates: true } as T;
        if (path === "/v1/users/me/mfa/totp/setup") return { secret: "SIMULATEDSECRETNOTREAL", otpauthUrl: "otpauth://totp/Apexy VPN:sim?secret=SIMULATEDSECRETNOTREAL" } as T;
        if (path === "/v1/users/me/mfa/totp/enable") return { recoveryCodes: Array.from({ length: 10 }, (_, i) => `sim${i}-code`) } as T;
        if (path === "/v1/subscription/checkout") {
          simAccount.subscription = "active";
          return { kind: "activated" } as T;
        }
        if (path === "/v1/subscription/cancel" || path === "/v1/subscription/resume") {
          simAccount.subscription = path.endsWith("cancel") ? "canceled" : "active";
          return subscriptionDto() as T;
        }
        if (path === "/v1/support/tickets") return [] as T;
        void method;
        return {} as T;
      },
      enrollDevice: async () => {
        await delay(700);
        const registration = { deviceId: "sim-device", publicKey: engine.device.publicKey, ipv4Address: "10.64.13.37", ipv6Address: null, validUntil: Date.now() + 5 * 86_400_000 };
        engine.device = { ...engine.device, registration };
        return registration;
      },
      createTicket: async () => {
        await delay(700);
        return { id: "sim-ticket", number: 1042 };
      },
      onSessionChange: (cb) => {
        simAccount.listeners.add(cb);
        return () => simAccount.listeners.delete(cb);
      },
    },
    app: {
      platform: "web",
      version: "0.1.0-sim",
      installedApps: async () => [
        { name: "Simulated Browser", path: "C:\\Program Files\\SimBrowser\\browser.exe" },
        { name: "Simulated Game Launcher", path: "C:\\Games\\Launcher\\launcher.exe" },
        { name: "Simulated Chat", path: "C:\\Users\\Public\\Chat\\chat.exe" },
      ],
      notify: async (title, body) => console.info(`[sim notification] ${title}: ${body}`),
      getAutostart: async () => false,
      setAutostart: async () => {},
      openExternal: async (url) => void window.open(url, "_blank", "noopener"),
      saveTextFile: async (name, contents) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([contents], { type: "text/plain" }));
        a.download = name;
        a.click();
        return true;
      },
      pickFiles: async () => [],
      setTray: async () => {},
      setCloseToTray: async () => {},
      hideWindow: async () => {},
      quit: async () => {},
      setGlobalShortcut: async () => true,
      onAppAction: () => () => {},
    },
  };
}
