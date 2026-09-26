/**
 * Everything the UI can *do*. Components call these; none of them changes
 * the connection state locally. They ask the service and wait for its event.
 */
import type { ConnectTarget, SettingsPatch } from "@/protocol";
import { useApp } from "@/state/store";
import type { Profile } from "@/state/types";
import { transport } from "./transportRef";

export async function connect(target?: ConnectTarget | null): Promise<void> {
  await transport().call("connect", { target: target ?? null });
}

export async function disconnect(): Promise<void> {
  await transport().call("disconnect");
}

export async function reconnect(): Promise<void> {
  await transport().call("reconnect");
}

export async function updateSettings(patch: Partial<SettingsPatch>): Promise<void> {
  const settings = await transport().call("update_settings", { patch: fillPatch(patch) });
  useApp.setState({ settings });
}

/** Rust's `SettingsPatch` has every field; absent ones must be `null`. */
function fillPatch(p: Partial<SettingsPatch>): SettingsPatch {
  return {
    protocol: p.protocol ?? null,
    killSwitch: p.killSwitch ?? null,
    allowLan: p.allowLan ?? null,
    dns: p.dns ?? null,
    network: p.network ?? null,
    splitTunnel: p.splitTunnel ?? null,
    autoConnect: p.autoConnect ?? null,
    trustedNetworks: p.trustedNetworks ?? null,
    defaultTarget: p.defaultTarget ?? null,
    logging: p.logging ?? null,
  };
}

export async function applyProfile(profile: Profile): Promise<void> {
  const hasOverrides = Object.values(profile.overrides).some((v) => v !== null && v !== undefined);
  if (hasOverrides) await updateSettings(profile.overrides);
  useApp.getState().setPrefs({ activeProfileId: profile.id });
  await connect(profile.target);
}

export function toggleFavorite(serverOrLocationId: string): void {
  const { prefs, setPrefs } = useApp.getState();
  const favorites = prefs.favorites.includes(serverOrLocationId)
    ? prefs.favorites.filter((f) => f !== serverOrLocationId)
    : [...prefs.favorites, serverOrLocationId];
  setPrefs({ favorites });
}

export function moveFavorite(id: string, by: -1 | 1): void {
  const { prefs, setPrefs } = useApp.getState();
  const list = [...prefs.favorites];
  const i = list.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j]!, list[i]!];
  setPrefs({ favorites: list });
}

export async function measureLatencies(serverIds?: string[]): Promise<void> {
  const samples = await transport().call("measure_latencies", { serverIds: serverIds ?? null });
  const latencies = { ...useApp.getState().latencies };
  for (const s of samples) latencies[s.serverId] = s;
  useApp.setState({ latencies });
}

export async function checkIp(): Promise<void> {
  await transport().call("check_ip");
  useApp.setState({ ip: await transport().call("get_ip_observations") });
}

type Subscription = NonNullable<ReturnType<typeof useApp.getState>["account"]["subscription"]>;

/** Statuses the backend grants access for (it reports "expired" once a period has passed). */
export function subscriptionAllowsConnecting(sub: Subscription): boolean {
  return sub.status === "trialing" || sub.status === "active" || sub.status === "past_due";
}

export async function refreshSubscription(): Promise<void> {
  const t = transport();
  try {
    const subscription = await t.account.request<Subscription>("GET", "/v1/subscription");
    useApp.setState((s) => ({ account: { ...s.account, subscription, offline: false } }));
    // After a renewal the service still holds the old expiry; re-enrolling
    // (idempotent) hands it the new one, so Connect works right away.
    const reg = useApp.getState().device?.registration;
    const end = subscription.currentPeriodEnd ? Date.parse(subscription.currentPeriodEnd) : null;
    if (reg && end && subscriptionAllowsConnecting(subscription) && (reg.validUntil ?? 0) < end) {
      await ensureEnrolled({ force: true }).catch(() => {});
    }
  } catch {
    useApp.setState((s) => ({ account: { ...s.account, offline: true } }));
  }
}

let enrolling: Promise<void> | null = null;
let refreshedThisRun = false;

/**
 * Links this device to the account (after sign-in), and once per app run
 * refreshes an existing link: enrollment is idempotent per key, and the
 * refresh picks up a renewed plan's validity and re-announces the key to
 * nodes that forget idle peers. The service keeps an active tunnel as it is.
 * Sign-in and the session event both ask for it; callers share one call.
 */
export function ensureEnrolled({ force = false }: { force?: boolean } = {}): Promise<void> {
  enrolling ??= (async () => {
    const t = transport();
    const device = useApp.getState().device ?? (await t.call("get_device"));
    if (device.registration && refreshedThisRun && !force) return;
    await t.account.enrollDevice();
    refreshedThisRun = true;
    useApp.setState({ device: await t.call("get_device") });
  })().finally(() => {
    enrolling = null;
  });
  return enrolling;
}

export async function signOut(): Promise<void> {
  const t = transport();
  // Disconnect first so the kill switch doesn't hold traffic for a device
  // that can no longer authenticate.
  if (useApp.getState().tunnel?.state !== "disconnected") await disconnect().catch(() => {});
  await t.call("clear_device_registration").catch(() => {});
  await t.account.logout();
  useApp.setState((s) => ({ account: { ...s.account, status: "signed_out", user: null, subscription: null } }));
}
