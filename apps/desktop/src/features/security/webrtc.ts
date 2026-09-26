/**
 * WebRTC exposure test, run in the app's own browser engine. It gathers ICE
 * candidates from a public STUN server: server-reflexive ("srflx")
 * candidates reveal the public address WebRTC would expose to a website.
 * The result describes this engine; a user's own browser may differ, and
 * the UI says so.
 */
import type { LeakTestResult } from "@/protocol";

const STUN = "stun:stun.l.google.com:19302";

export async function webrtcExposure(vpnIp: string | null, ownIp: string | null, timeoutMs = 4000): Promise<LeakTestResult> {
  const now = Date.now();
  const base = { test: "webrtc" as const, testedAt: now, expected: vpnIp ? [vpnIp] : [] };
  if (typeof RTCPeerConnection === "undefined") {
    return { ...base, verdict: "unable_to_verify", finding: "webrtc_unavailable", observed: [] };
  }
  const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN }] });
  const found = new Set<string>();
  try {
    pc.createDataChannel("probe");
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      pc.onicecandidate = (e) => {
        if (!e.candidate) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const c = e.candidate.candidate;
        if (c.includes(" typ srflx")) {
          const ip = c.split(" ")[4];
          if (ip) found.add(ip);
        }
      };
    });
    await pc.setLocalDescription(await pc.createOffer());
    await done;
  } finally {
    pc.close();
  }
  const observed = [...found];
  if (observed.length === 0) return { ...base, verdict: "unable_to_verify", finding: "webrtc_no_candidates", observed };
  if (ownIp && observed.includes(ownIp) && ownIp !== vpnIp) return { ...base, verdict: "potential_leak", finding: "webrtc_exposes_own_ip", observed };
  if (vpnIp && observed.every((ip) => ip === vpnIp)) return { ...base, verdict: "protected", finding: "webrtc_matches_vpn", observed };
  return { ...base, verdict: "unable_to_verify", finding: "webrtc_no_candidates", observed };
}
