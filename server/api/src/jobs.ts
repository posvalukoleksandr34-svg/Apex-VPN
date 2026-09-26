import { connect } from "node:net";
import type { AppDeps } from "./deps.js";

/**
 * Background work: fleet reachability probes, data retention, and
 * subscription expiry. Each job logs and survives its own failures.
 */
export function startJobs(deps: AppDeps, log: (msg: string) => void): () => void {
  const timers = [
    every(60_000, () => probeFleet(deps), log, "fleet probe"),
    every(60 * 60_000, () => retention(deps), log, "retention"),
    every(10 * 60_000, () => expireSubscriptions(deps), log, "subscription expiry"),
    every(60_000, async () => deps.activePeers.prune(), log, "active peer pruning"),
  ];
  void probeFleet(deps).catch((e) => log(`fleet probe failed: ${e}`));
  return () => timers.forEach(clearInterval);
}

function every(ms: number, fn: () => Promise<unknown>, log: (m: string) => void, name: string) {
  return setInterval(() => void fn().catch((e) => log(`${name} failed: ${e}`)), ms);
}

/** TCP reachability of each node's monitor port, recorded as measured. */
export async function probeFleet(deps: AppDeps): Promise<void> {
  const servers = await deps.database.db
    .selectFrom("fleet.servers")
    .select(["id", "ipv4", "monitor_tcp_port"])
    .where("monitor_tcp_port", "is not", null)
    .execute();
  await Promise.all(
    servers.map(async (s) => {
      const rtt = await tcpRtt(s.ipv4.replace(/\/32$/, ""), s.monitor_tcp_port!, 3000);
      await deps.database.db
        .insertInto("fleet.health_samples")
        .values({ server_id: s.id, source: "monitor", reachable: rtt !== null, rtt_ms: rtt })
        .execute();
    }),
  );
}

function tcpRtt(host: string, port: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = connect({ host, port, timeout: timeoutMs });
    const done = (v: number | null) => {
      socket.destroy();
      resolve(v);
    };
    socket.on("connect", () => done(Math.max(1, Math.round(performance.now() - started))));
    socket.on("timeout", () => done(null));
    socket.on("error", () => done(null));
  });
}

async function retention(deps: AppDeps): Promise<void> {
  const { db } = deps.database;
  const now = deps.now().getTime();
  await db.deleteFrom("fleet.health_samples").where("measured_at", "<", new Date(now - 7 * 86_400_000)).execute();
  await db.deleteFrom("fleet.relay_lists").where("generated_at", "<", new Date(now - 2 * 86_400_000)).execute();
  await db.deleteFrom("identity.email_tokens").where("expires_at", "<", new Date(now - 86_400_000)).execute();
  await db.deleteFrom("identity.sessions").where("expires_at", "<", new Date(now - 30 * 86_400_000)).execute();
  await db.deleteFrom("diag.reports").where("created_at", "<", new Date(now - 90 * 86_400_000)).execute();
}

async function expireSubscriptions(deps: AppDeps): Promise<void> {
  await deps.database.db
    .updateTable("billing.subscriptions")
    .set({ status: "expired", updated_at: deps.now() })
    .where("status", "in", ["trialing", "active", "past_due"])
    .where("current_period_end", "<", deps.now())
    .execute();
}
