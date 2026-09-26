import { describe as suite, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import type { ServiceStatus } from "@/platform/transport";
import { allStates, CAUSES, ERROR_KINDS, PHASES } from "@/test/fixtures";
import { describe, primaryIntent } from "./status";

const NOW = 1_700_000_000_000;
const SERVICES: ServiceStatus[] = ["unavailable", "connecting", "ready"];

function has(key: string): boolean {
  let node: unknown = en;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object" || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string";
}

suite("describe()", () => {
  it("says protected only for a connected tunnel on a reachable service", () => {
    for (const service of SERVICES) {
      for (const { name, state } of [...allStates(NOW), { name: "no state", state: null }]) {
        const view = describe(service, state, NOW);
        const expected = service === "ready" && state?.state === "connected";
        expect(view.protected, `${service} / ${name}`).toBe(expected);
        expect(view.tone === "success", `${service} / ${name}`).toBe(expected);
        expect(view.title === "status.connected.title", `${service} / ${name}`).toBe(expected);
      }
    }
  });

  it("does not trust a stale connected state while the service is down or starting", () => {
    const connected = allStates(NOW).find((s) => s.name === "connected")!.state;
    expect(describe("unavailable", connected, NOW).kind).toBe("service_unavailable");
    expect(describe("connecting", connected, NOW).kind).toBe("service_starting");
  });

  it("uses only keys that exist in the English strings", () => {
    for (const service of SERVICES) {
      for (const { name, state } of allStates(NOW)) {
        const view = describe(service, state, NOW);
        expect(has(view.title), `${name}: ${view.title}`).toBe(true);
        expect(has(view.detail), `${name}: ${view.detail}`).toBe(true);
        for (const action of [view.primary, ...view.secondary].filter(Boolean)) {
          expect(has(`actions.${action}`), `${name}: actions.${action}`).toBe(true);
        }
      }
    }
  });

  it("reports the kill switch as blocking exactly when the service says so", () => {
    for (const { name, state } of allStates(NOW)) {
      const view = describe("ready", state, NOW);
      const expected = "blocking" in state ? state.blocking : state.state === "disconnected" && state.lockedDown;
      expect(view.blocking, name).toBe(expected);
    }
  });

  it("offers a way out of every blocking state", () => {
    for (const { name, state } of allStates(NOW)) {
      const view = describe("ready", state, NOW);
      if (!view.blocking) continue;
      const exits = [view.primary, ...view.secondary];
      // Cancel/unblock disconnect; connect (locked-down) is the way forward.
      expect(exits.some((a) => a === "cancel" || a === "unblock" || a === "connect"), name).toBe(true);
    }
  });

  it("counts down to the next retry", () => {
    const retry = allStates(NOW).find((s) => s.name === "connecting waiting_to_retry blocking=false")!.state;
    const view = describe("ready", retry, NOW);
    expect(view.detail).toBe("status.connecting.retrying");
    expect(view.values.seconds).toBe(5);
    expect(describe("ready", retry, NOW + 10_000).values.seconds).toBe(0);
  });

  it("points non-retryable errors at the step that fixes them", () => {
    const err = (kind: (typeof ERROR_KINDS)[number]) => describe("ready", { state: "error", error: { kind, detail: null, at: NOW }, blocking: false }, NOW);
    expect(err("auth_required").primary).toBe("sign_in");
    expect(err("subscription_inactive").primary).toBe("view_plans");
    expect(err("firewall_failure").primary).toBe("open_diagnostics");
    expect(err("firewall_failure").secondary).not.toContain("open_diagnostics");
    expect(err("handshake_timeout").primary).toBe("retry");
  });

  it("maps the main button to connect or disconnect", () => {
    const intent = (name: string) => primaryIntent(describe("ready", allStates(NOW).find((s) => s.name === name)!.state, NOW));
    expect(intent("disconnected lockedDown=false")).toBe("connect");
    expect(intent("connected")).toBe("disconnect");
    expect(intent("connecting handshaking blocking=true")).toBe("disconnect");
    expect(intent("error tunnel_failure blocking=false")).toBe("connect");
    expect(intent("error auth_required blocking=false")).toBeNull();
    expect(intent("disconnecting")).toBeNull();
  });
});

suite("state vocabulary", () => {
  it("has user-facing text for every error, phase and reconnect cause", () => {
    for (const kind of ERROR_KINDS) {
      for (const part of ["title", "explanation", "cause", "action"]) expect(has(`errors.${kind}.${part}`), `errors.${kind}.${part}`).toBe(true);
    }
    for (const phase of PHASES) expect(has(`phase.${phase}`), phase).toBe(true);
    for (const cause of CAUSES) expect(has(`cause.${cause}`), cause).toBe(true);
  });
});
