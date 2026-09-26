import { ServiceError } from "@/protocol";
import { ApiFailure, type ClientTransport } from "./transport";

/**
 * Used when the UI runs outside the desktop app without the simulator
 * (e.g. opened in a browser). There is no service and no account here, and
 * the UI says so rather than showing anything invented.
 */
export function createUnavailableTransport(): ClientTransport {
  const noService = () => Promise.reject(new ServiceError("unavailable", "no VPN service in this environment", null));
  const noApi = () => Promise.reject(new ApiFailure("network", 0));
  const noop = () => () => {};
  return {
    kind: "tauri",
    call: noService as ClientTransport["call"],
    onEvent: noop,
    onServiceStatus: (cb) => {
      queueMicrotask(() => cb("unavailable"));
      return () => {};
    },
    reconnectService: async () => {},
    account: {
      session: async () => null,
      register: noApi,
      verifyEmail: noApi,
      resendVerification: noApi,
      login: noApi,
      loginMfa: noApi,
      logout: async () => {},
      forgotPassword: noApi,
      resetPassword: noApi,
      request: noApi,
      enrollDevice: noApi,
      createTicket: noApi,
      onSessionChange: noop,
    },
    app: {
      platform: "web",
      version: "0.1.0",
      installedApps: async () => [],
      notify: async () => {},
      getAutostart: async () => false,
      setAutostart: async () => {},
      openExternal: async (url) => void window.open(url, "_blank", "noopener"),
      saveTextFile: async () => false,
      pickFiles: async () => [],
      setTray: async () => {},
      setCloseToTray: async () => {},
      hideWindow: async () => {},
      quit: async () => {},
      setGlobalShortcut: async () => false,
      onAppAction: noop,
    },
  };
}
