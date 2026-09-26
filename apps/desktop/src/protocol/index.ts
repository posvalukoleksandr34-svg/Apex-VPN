/**
 * The service protocol, as TypeScript. Shapes come from the Rust types
 * (ts-rs, `generated/`); this file adds the method → result mapping so every
 * call site is typed end to end.
 */
import type {
  Capabilities,
  CheckResult,
  ConnectionReport,
  DeviceInfo,
  DnsTestResult,
  HelloReply,
  IpObservation,
  IpObservations,
  LatencySample,
  LeakTestResult,
  LogEntry,
  NetworkSnapshot,
  RelayListReply,
  RelayListStatus,
  Request,
  Settings,
  TunnelState,
  TunnelStats,
} from "./generated";

export type * from "./generated";

export type Method = Request["method"];

type RequestOf<M extends Method> = Extract<Request, { method: M }>;
export type ParamsOf<M extends Method> = RequestOf<M> extends { params: infer P } ? P : undefined;

/** Mirrors `crates/vpn-daemon/src/handler.rs`. */
export interface ResultMap {
  hello: HelloReply;
  subscribe: null;
  get_state: TunnelState;
  connect: null;
  disconnect: null;
  reconnect: null;
  get_settings: Settings;
  update_settings: Settings;
  reset_settings: Settings;
  get_capabilities: Capabilities;
  get_relay_list: RelayListReply;
  refresh_relay_list: RelayListStatus;
  get_latencies: LatencySample[];
  measure_latencies: LatencySample[];
  get_device: DeviceInfo;
  set_device_registration: DeviceInfo;
  clear_device_registration: DeviceInfo;
  rotate_device_key: DeviceInfo;
  get_stats: TunnelStats | null;
  get_connection_report: ConnectionReport;
  get_network: NetworkSnapshot;
  check_ip: IpObservation;
  get_ip_observations: IpObservations;
  run_leak_tests: LeakTestResult[];
  test_dns: DnsTestResult[];
  run_diagnostics: CheckResult[];
  get_logs: LogEntry[];
  export_logs: string;
  clear_logs: null;
}

export type ResultOf<M extends Method> = M extends keyof ResultMap ? ResultMap[M] : never;

/** An error returned by the service (`IpcError`). */
export class ServiceError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly errorKind: string | null,
  ) {
    super(message);
  }
}
