/**
 * Production transport. Every call goes to the app's Rust core
 * (apps/desktop/src-tauri): service requests are forwarded over the local
 * IPC pipe, account requests go to the backend with tokens that live only in
 * the OS keychain.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Event, Method } from "@/protocol";
import { ServiceError } from "@/protocol";
import { ApiFailure, type ClientTransport, type ServiceStatus, type User } from "./transport";

interface CoreError {
  kind: "service" | "api" | "internal";
  code: string;
  message: string;
  status?: number;
  errorKind?: string | null;
}

function toError(e: unknown): Error {
  const err = e as CoreError;
  if (err && typeof err === "object" && "kind" in err) {
    if (err.kind === "api") return new ApiFailure(err.code, err.status ?? 0, err.message);
    if (err.kind === "service") return new ServiceError(err.code, err.message, err.errorKind ?? null);
  }
  return new Error(typeof e === "string" ? e : "unexpected error");
}

async function core<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toError(e);
  }
}

function subscribe<T>(event: string, cb: (payload: T) => void): () => void {
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void listen<T>(event, (e) => cb(e.payload)).then((u) => (cancelled ? u() : (unlisten = u)));
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

export async function createTauriTransport(): Promise<ClientTransport> {
  const info = await core<{ platform: ClientTransport["app"]["platform"]; version: string }>("app_info");
  return {
    kind: "tauri",
    call: ((method: Method, params?: unknown) =>
      core("service_request", { request: params === undefined ? { method } : { method, params } })) as ClientTransport["call"],
    onEvent: (cb) => subscribe<Event>("service://event", cb),
    onServiceStatus: (cb) => {
      const off = subscribe<ServiceStatus>("service://status", cb);
      void core<ServiceStatus>("service_status").then(cb);
      return off;
    },
    reconnectService: () => core("service_reconnect"),
    account: {
      session: () => core<User | null>("account_session"),
      register: (email, password, locale) => core("account_register", { email, password, locale }),
      verifyEmail: (email, code) => core("account_verify_email", { email, code }),
      resendVerification: (email) => core("account_resend_verification", { email }),
      login: (email, password) => core("account_login", { email, password }),
      loginMfa: (input) => core("account_login_mfa", { input }),
      logout: () => core("account_logout"),
      forgotPassword: (email) => core("account_forgot_password", { email }),
      resetPassword: (email, code, newPassword) => core("account_reset_password", { email, code, newPassword }),
      request: (method, path, body) => core("account_request", { method, path, body: body ?? null }),
      enrollDevice: () => core("account_enroll_device"),
      createTicket: (input) => core("support_create_ticket", { input }),
      onSessionChange: (cb) => subscribe<User | null>("account://session", cb),
    },
    app: {
      platform: info.platform,
      version: info.version,
      installedApps: () => core("app_installed_apps"),
      notify: (title, body) => core("app_notify", { title, body }),
      getAutostart: () => core("app_get_autostart"),
      setAutostart: (on) => core("app_set_autostart", { on }),
      openExternal: (url) => core("app_open_external", { url }),
      saveTextFile: (defaultName, contents) => core("app_save_text_file", { defaultName, contents }),
      pickFiles: () => core("app_pick_files"),
      setTray: (view) => core("app_set_tray", { view }),
      setCloseToTray: (on) => core("app_set_close_to_tray", { on }),
      hideWindow: () => core("app_hide_window"),
      quit: () => core("app_quit"),
      setGlobalShortcut: (accelerator) => core("app_set_global_shortcut", { accelerator }),
      onAppAction: (cb) => subscribe<string>("app://action", cb),
    },
  };
}
