import type { ClientTransport } from "@/platform/transport";

let current: ClientTransport | null = null;

export function setTransport(t: ClientTransport): void {
  current = t;
}

/** The active transport. Set once at startup, before the UI renders. */
export function transport(): ClientTransport {
  if (!current) throw new Error("transport not initialised");
  return current;
}
