/**
 * Everything the UI can ask of the outside world goes through this
 * interface. Two implementations:
 *
 * * `TauriTransport`: production. Service calls go over IPC through the
 *   app's Rust core; account calls go to the backend from Rust, which keeps
 *   the tokens in the OS keychain. The WebView never sees a token.
 * * `SimulatorTransport`: development only, for building UI in a browser.
 *   It is excluded from production bundles and always shows a banner.
 */
import type { DeviceRegistration, Event, Method, ParamsOf, ResultOf } from "@/protocol";

export type ServiceStatus = "connecting" | "ready" | "unavailable";
export type Unsubscribe = () => void;

export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  locale: string;
  mfaEnabled: boolean;
  createdAt: string;
}

export type LoginResult = { kind: "signed_in"; user: User } | { kind: "mfa_required" };

/** An error answered by the backend: stable `code`, HTTP `status`. */
export class ApiFailure extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface AccountApi {
  /** The signed-in user, or null. Refreshes tokens as needed. */
  session(): Promise<User | null>;
  register(email: string, password: string, locale: string): Promise<void>;
  verifyEmail(email: string, code: string): Promise<void>;
  resendVerification(email: string): Promise<void>;
  login(email: string, password: string): Promise<LoginResult>;
  loginMfa(input: { code: string } | { recoveryCode: string }): Promise<User>;
  logout(): Promise<void>;
  forgotPassword(email: string): Promise<void>;
  resetPassword(email: string, code: string, newPassword: string): Promise<void>;
  /** Authenticated call to the backend (path like `/v1/devices`). */
  request<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
  /** Registers the service's device key with the account and hands the registration to the service. */
  enrollDevice(): Promise<DeviceRegistration>;
  /** Files a support ticket (attachments are paths chosen with `pickFiles`). */
  createTicket(input: {
    subject: string;
    category: string;
    description: string;
    attachmentPaths: string[];
    diagnosticReport: unknown | null;
  }): Promise<{ id: string; number: number }>;
  onSessionChange(cb: (user: User | null) => void): Unsubscribe;
}

export interface PickedFile {
  name: string;
  path: string;
  size: number;
}

export interface TrayView {
  tone: string;
  label: string;
  canConnect: boolean;
  canDisconnect: boolean;
  /** The tray menu is native, so the UI sends its labels already translated. */
  menu: { show: string; connect: string; disconnect: string; quit: string };
}

export interface AppApi {
  readonly platform: "windows" | "macos" | "linux" | "web";
  readonly version: string;
  installedApps(): Promise<{ name: string; path: string }[]>;
  notify(title: string, body: string): Promise<void>;
  getAutostart(): Promise<boolean>;
  setAutostart(on: boolean): Promise<void>;
  openExternal(url: string): Promise<void>;
  saveTextFile(defaultName: string, contents: string): Promise<boolean>;
  pickFiles(): Promise<PickedFile[]>;
  setTray(view: TrayView): Promise<void>;
  setCloseToTray(on: boolean): Promise<void>;
  hideWindow(): Promise<void>;
  quit(): Promise<void>;
  /** Registers the global show/hide shortcut (e.g. "Ctrl+Alt+M"); returns false if taken. */
  setGlobalShortcut(accelerator: string | null): Promise<boolean>;
  /** Tray/menu actions ("connect", "disconnect", "show") forwarded to the UI. */
  onAppAction(cb: (action: string) => void): Unsubscribe;
}

export interface ClientTransport {
  readonly kind: "tauri" | "simulator";
  call<M extends Method>(method: M, ...params: ParamsOf<M> extends undefined ? [] : [ParamsOf<M>]): Promise<ResultOf<M>>;
  onEvent(cb: (event: Event) => void): Unsubscribe;
  onServiceStatus(cb: (status: ServiceStatus) => void): Unsubscribe;
  /** Asks the core to reconnect to the service now. */
  reconnectService(): Promise<void>;
  account: AccountApi;
  app: AppApi;
}
