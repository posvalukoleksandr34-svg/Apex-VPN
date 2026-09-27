import type { CheckResult } from "@/protocol";
import { ApiFailure } from "@/platform/transport";
import type { AppState } from "@/state/store";
import { transport } from "@/app/transportRef";

/** The one check only the app can run: account session, device, plan. */
export async function authenticationCheck(state: AppState): Promise<CheckResult> {
  const started = performance.now();
  const done = (status: CheckResult["status"], finding: string, evidence: Record<string, unknown> = {}): CheckResult => ({
    id: "authentication",
    status,
    finding,
    evidence,
    durationMs: Math.round(performance.now() - started),
  });
  try {
    const user = await transport().account.session();
    if (!user) return done("failed", "signed_out");
    const device = state.device ?? (await transport().call("get_device"));
    if (!device.registration) return done("failed", "device_not_registered");
    const sub = await transport().account.request<{ status: string }>("GET", "/v1/subscription");
    if (!["trialing", "active", "past_due"].includes(sub.status)) return done("failed", "subscription_inactive", { status: sub.status });
    return done("working", "signed_in", { plan: sub.status });
  } catch (e) {
    if (e instanceof ApiFailure && e.code !== "network") return done("warning", "signed_out", { code: e.code });
    return done("warning", "api_unreachable");
  }
}

/** Plain-text report for copying or attaching to a ticket (already redacted by the service). */
export function reportText(checks: CheckResult[], state: AppState, t: (k: string) => string): string {
  const lines = [
    `Apexy VPN diagnostics — ${new Date().toISOString()}`,
    `App ${transport().app.version} · service ${state.capabilities?.serviceVersion ?? "unavailable"} · ${state.capabilities ? `${state.capabilities.os.family} ${state.capabilities.os.version}` : ""}`,
    `Tunnel: ${state.tunnel?.state ?? "unknown"}`,
    "",
  ];
  for (const c of checks) {
    lines.push(`[${c.status.toUpperCase()}] ${t(`diagnostics.checks.${c.id}`)} — ${c.finding} (${c.durationMs} ms)`);
    if (Object.keys(c.evidence).length) lines.push(`    ${JSON.stringify(c.evidence)}`);
  }
  return lines.join("\n");
}
