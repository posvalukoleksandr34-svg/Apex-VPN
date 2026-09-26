/**
 * DEVELOPMENT SIMULATOR ONLY: controls to drive the simulated service
 * through the scenarios the real one handles (slow network, handshake
 * failures, network loss and change, sleep/wake, service stop, errors,
 * subscription states).
 */
import { FlaskConical, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ErrorKind } from "@/protocol";
import { engine, simAccount } from "./transport";

const ERRORS: ErrorKind[] = ["handshake_timeout", "server_unavailable", "dns_failure", "firewall_failure", "auth_required", "subscription_inactive", "relay_list_invalid", "driver_unavailable"];

export default function DevPanel() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [, force] = useState(0);
  const refresh = () => force((n) => n + 1);
  const box: React.CSSProperties = {
    position: "fixed",
    right: 16,
    bottom: 16,
    zIndex: 80,
    fontSize: 12,
  };
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} style={{ ...box, display: "flex", gap: 6, alignItems: "center", padding: "8px 12px", borderRadius: 999, border: "1px solid #6a4600", background: "#3a2a00", color: "#ffe2a8", cursor: "pointer" }}>
        <FlaskConical size={14} /> {t("dev.panel")}
      </button>
    );
  }
  const btn: React.CSSProperties = { padding: "5px 8px", borderRadius: 6, border: "1px solid #6a4600", background: "#2a1f00", color: "#ffe2a8", cursor: "pointer", textAlign: "left" };
  return (
    <div role="region" aria-label={t("dev.panel")} style={{ ...box, width: 260, padding: 12, borderRadius: 12, background: "#1c1500", border: "1px solid #6a4600", color: "#ffe2a8", display: "grid", gap: 6, boxShadow: "0 12px 40px rgba(0,0,0,.5)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>{t("dev.panel")}</strong>
        <button type="button" onClick={() => setOpen(false)} aria-label={t("actions.close")} style={{ ...btn, padding: 4 }}>
          <X size={12} />
        </button>
      </div>
      <label>
        <input type="checkbox" checked={engine.flags.slowNetwork} onChange={(e) => ((engine.flags.slowNetwork = e.target.checked), refresh())} /> {t("dev.slowNetwork")}
      </label>
      <label>
        <input type="checkbox" checked={engine.flags.failHandshake} onChange={(e) => ((engine.flags.failHandshake = e.target.checked), refresh())} /> {t("dev.failHandshake")}
      </label>
      <button type="button" style={btn} onClick={() => engine.dropNetwork()}>{t("dev.dropNetwork")}</button>
      <button type="button" style={btn} onClick={() => engine.restoreNetwork()}>{t("dev.restoreNetwork")}</button>
      <button type="button" style={btn} onClick={() => engine.networkChange()}>{t("dev.networkChange")}</button>
      <button type="button" style={btn} onClick={() => engine.sleepWake()}>{t("dev.sleepWake")}</button>
      <button type="button" style={btn} onClick={() => engine.setService(engine.service === "ready" ? "unavailable" : "ready")}>
        {engine.service === "ready" ? t("dev.stopService") : t("dev.startService")}
      </button>
      <label style={{ display: "grid", gap: 4 }}>
        {t("dev.error")}
        <select style={btn} value="" onChange={(e) => e.target.value && engine.injectError(e.target.value as ErrorKind)}>
          <option value="">—</option>
          {ERRORS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "grid", gap: 4 }}>
        {t("dev.subscription")}
        <select style={btn} value={simAccount.subscription} onChange={(e) => ((simAccount.subscription = e.target.value as typeof simAccount.subscription), refresh())}>
          {["trialing", "active", "past_due", "canceled", "expired", "none"].map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
