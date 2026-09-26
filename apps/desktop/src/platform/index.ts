import type { ClientTransport } from "./transport";

declare const __SIMULATOR__: boolean;

/**
 * Picks the transport for this runtime:
 * * inside the desktop app → Tauri (real service, real account);
 * * a `--mode simulator` dev build → the simulator (clearly bannered);
 * * anything else (a browser) → "service unavailable", honestly.
 *
 * `__SIMULATOR__` is a build-time constant, so production bundles don't
 * contain the simulator at all.
 */
export async function createTransport(): Promise<ClientTransport> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { createTauriTransport } = await import("./tauri");
    return createTauriTransport();
  }
  if (__SIMULATOR__) {
    const { createSimulatorTransport } = await import("./simulator/transport");
    return createSimulatorTransport();
  }
  const { createUnavailableTransport } = await import("./unavailable");
  return createUnavailableTransport();
}
