/**
 * The one mapping from service state to what the user sees. The dashboard,
 * title bar, tray, security page and notifications all call `describe()`,
 * so two surfaces can never disagree, and "Protected" appears only for a
 * `connected` state the service reported.
 */
import type { ErrorKind, TunnelState } from "@/protocol";
import type { ServiceStatus } from "@/platform/transport";

export type Tone = "neutral" | "pending" | "success" | "warning" | "error";

export type ActionId =
  | "connect"
  | "disconnect"
  | "cancel"
  | "retry"
  | "unblock"
  | "reconnect_service"
  | "open_diagnostics"
  | "kill_switch_settings"
  | "sign_in"
  | "view_plans";

export interface StatusView {
  kind: "service_unavailable" | "service_starting" | "unknown" | "locked_down" | TunnelState["state"];
  tone: Tone;
  /** i18n key + values */
  title: string;
  detail: string;
  values: Record<string, string | number>;
  primary: ActionId | null;
  secondary: ActionId[];
  /** The kill switch is holding traffic. */
  blocking: boolean;
  /** Something is in progress (spinner). */
  busy: boolean;
  /** True only when the service reports a verified tunnel. */
  protected: boolean;
}

const base = { values: {}, secondary: [] as ActionId[], blocking: false, busy: false, protected: false };

/** Errors that retrying won't fix; the matching next step instead. */
const ERROR_NEXT_STEP: Partial<Record<ErrorKind, ActionId>> = {
  auth_required: "sign_in",
  subscription_inactive: "view_plans",
  firewall_failure: "open_diagnostics",
  driver_unavailable: "open_diagnostics",
  permission_denied: "open_diagnostics",
  unsupported_platform: "open_diagnostics",
};

export function describe(service: ServiceStatus, state: TunnelState | null, now = Date.now()): StatusView {
  if (service === "unavailable") {
    return {
      ...base,
      kind: "service_unavailable",
      tone: "error",
      title: "status.serviceUnavailable.title",
      detail: "status.serviceUnavailable.detail",
      primary: "reconnect_service",
      secondary: ["open_diagnostics"],
    };
  }
  if (service === "connecting") {
    return { ...base, kind: "service_starting", tone: "pending", title: "status.serviceStarting.title", detail: "status.serviceStarting.detail", primary: null, busy: true };
  }
  if (!state) {
    return { ...base, kind: "unknown", tone: "pending", title: "status.unknown.title", detail: "status.unknown.detail", primary: null, busy: true };
  }

  switch (state.state) {
    case "disconnected":
      return state.lockedDown
        ? {
            ...base,
            kind: "locked_down",
            tone: "warning",
            title: "status.lockedDown.title",
            detail: "status.lockedDown.detail",
            primary: "connect",
            secondary: ["kill_switch_settings"],
            blocking: true,
          }
        : { ...base, kind: "disconnected", tone: "neutral", title: "status.disconnected.title", detail: "status.disconnected.detail", primary: "connect" };

    case "connecting": {
      const retrying = state.phase === "waiting_to_retry" && state.retryAt !== null;
      return {
        ...base,
        kind: "connecting",
        tone: "pending",
        title: "status.connecting.title",
        detail: retrying ? "status.connecting.retrying" : `phase.${state.phase}`,
        values: {
          seconds: retrying ? Math.max(0, Math.ceil((state.retryAt! - now) / 1000)) : 0,
          attempt: state.attempt,
          error: state.lastError ?? "",
          server: state.relay?.city ?? "",
        },
        primary: "cancel",
        blocking: state.blocking,
        busy: true,
      };
    }

    case "connected":
      return {
        ...base,
        kind: "connected",
        tone: "success",
        title: "status.connected.title",
        detail: "status.connected.detail",
        values: { city: state.details.relay.city, country: state.details.relay.country },
        primary: "disconnect",
        protected: true,
      };

    case "reconnecting":
      return {
        ...base,
        kind: "reconnecting",
        tone: "pending",
        title: "status.reconnecting.title",
        detail: `cause.${state.cause}`,
        values: { attempt: state.attempt },
        primary: "cancel",
        blocking: state.blocking,
        busy: true,
      };

    case "waiting_for_network":
      return {
        ...base,
        kind: "waiting_for_network",
        tone: "warning",
        title: "status.offline.title",
        detail: state.blocking ? "status.offline.detailBlocked" : "status.offline.detail",
        primary: "cancel",
        secondary: ["open_diagnostics"],
        blocking: state.blocking,
      };

    case "disconnecting":
      return { ...base, kind: "disconnecting", tone: "pending", title: "status.disconnecting.title", detail: "status.disconnecting.detail", primary: null, busy: true };

    case "error": {
      const kind = state.error.kind;
      const next = ERROR_NEXT_STEP[kind];
      const secondary: ActionId[] = [];
      if (state.blocking) secondary.push("unblock");
      if (next !== "open_diagnostics") secondary.push("open_diagnostics");
      return {
        ...base,
        kind: "error",
        tone: "error",
        title: `errors.${kind}.title`,
        detail: state.blocking ? "status.error.detailBlocked" : `errors.${kind}.explanation`,
        values: {},
        primary: next ?? "retry",
        secondary,
        blocking: state.blocking,
      };
    }
  }
}

/** The action a single "main button" press performs in this state. */
export function primaryIntent(view: StatusView): "connect" | "disconnect" | null {
  switch (view.primary) {
    case "connect":
    case "retry":
      return "connect";
    case "disconnect":
    case "cancel":
      return "disconnect";
    default:
      return null;
  }
}
