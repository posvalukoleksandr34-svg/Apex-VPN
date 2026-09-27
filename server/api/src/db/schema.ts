import type { ColumnType, Generated } from "kysely";

/** Kysely types for migrations/*.sql. Keep in step with the SQL. */

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type DateOnly = ColumnType<string, string | undefined, string>;
type Json<T = unknown> = ColumnType<T, string, string>;

export interface UsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string;
  email_verified_at: NullableTimestamp;
  locale: Generated<string>;
  role: Generated<"user" | "admin">;
  is_banned: Generated<boolean>;
  totp_secret_enc: string | null;
  totp_enabled_at: NullableTimestamp;
  totp_last_step: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  failed_logins: Generated<number>;
  locked_until: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RecoveryCodesTable {
  id: Generated<string>;
  user_id: string;
  code_hash: string;
  used_at: NullableTimestamp;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  family_id: string;
  refresh_hash: string;
  device_name: Generated<string>;
  platform: Generated<string>;
  created_at: Generated<Date>;
  last_used_on: Generated<string>;
  expires_at: Timestamp;
  rotated_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  revoked_reason: string | null;
}

export interface EmailTokensTable {
  id: Generated<string>;
  user_id: string;
  purpose: "verify_email" | "reset_password";
  code_hash: string;
  attempts: Generated<number>;
  expires_at: Timestamp;
  used_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface DevicesTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  platform: "windows" | "macos" | "linux" | "other";
  app_version: string | null;
  wg_public_key: string;
  ipv4: string;
  ipv6: string | null;
  created_at: Generated<Date>;
  last_seen_on: DateOnly;
  revoked_at: NullableTimestamp;
}

export interface ProfilesTable {
  id: string;
  user_id: string;
  name: string;
  kind: string;
  data: Json;
  updated_at: Generated<Date>;
}

export interface PlansTable {
  id: string;
  name: string;
  period: "trial" | "month" | "year";
  price_cents: number;
  currency: string;
  device_limit: number;
  active: Generated<boolean>;
  stripe_price_id: string | null;
}

export type SubscriptionStatus = "incomplete" | "trialing" | "active" | "past_due" | "canceled" | "expired";

export interface SubscriptionsTable {
  id: Generated<string>;
  user_id: string;
  plan_id: string;
  status: SubscriptionStatus;
  current_period_start: Timestamp;
  current_period_end: Timestamp;
  cancel_at_period_end: Generated<boolean>;
  provider: string;
  provider_ref: string | null;
  provider_synced_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CustomersTable {
  user_id: string;
  provider: string;
  customer_ref: string;
  created_at: Generated<Date>;
}

export interface InvoicesTable {
  id: Generated<string>;
  user_id: string;
  subscription_id: string | null;
  number: string;
  description: string;
  amount_cents: number;
  currency: string;
  status: "paid" | "open" | "void" | "refunded";
  issued_at: Generated<Date>;
  paid_at: NullableTimestamp;
  provider_ref: string | null;
  hosted_url: string | null;
}

export interface PaymentMethodsTable {
  id: Generated<string>;
  user_id: string;
  provider: string;
  provider_ref: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  is_default: Generated<boolean>;
}

export interface WebhookEventsTable {
  provider: string;
  event_id: string;
  received_at: Generated<Date>;
  event_type: string | null;
}

export interface LocationsTable {
  id: string;
  country_code: string;
  country: string;
  city: string;
  latitude: number;
  longitude: number;
}

export type ServerStatus = "online" | "busy" | "maintenance" | "offline";

export interface ServersTable {
  id: string;
  hostname: string;
  location_id: string;
  ipv4: string;
  ipv6: string | null;
  status: Generated<ServerStatus>;
  capacity: Generated<number>;
  features: Generated<string[]>;
  wg_public_key: string | null;
  wg_ports: Generated<number[]>;
  wg_gateway_ipv4: string | null;
  wg_gateway_ipv6: string | null;
  wg_dns_ipv4: Generated<string | null>;
  node_token_hash: string | null;
  monitor_tcp_port: number | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface HealthSamplesTable {
  id: Generated<string>;
  server_id: string;
  source: "monitor" | "node";
  measured_at: Generated<Date>;
  reachable: boolean | null;
  rtt_ms: number | null;
  packet_loss: number | null;
  active_peers: number | null;
  wg_healthy: boolean | null;
}

export interface RelayListsTable {
  version: Generated<string>;
  generated_at: Generated<Date>;
  expires_at: Timestamp;
  payload: string;
  signature: string;
  key_id: string;
}

export interface ReportsTable {
  id: Generated<string>;
  user_id: string | null;
  app_version: string | null;
  os: string | null;
  report: Json;
  created_at: Generated<Date>;
}

export interface TicketsTable {
  id: Generated<string>;
  number: Generated<number>;
  user_id: string;
  subject: string;
  category: "connection" | "billing" | "account" | "privacy" | "other";
  status: Generated<"open" | "pending" | "resolved" | "closed">;
  diagnostic_report_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MessagesTable {
  id: Generated<string>;
  ticket_id: string;
  author: "user" | "staff";
  body: string;
  created_at: Generated<Date>;
}

export interface AttachmentsTable {
  id: Generated<string>;
  ticket_id: string;
  message_id: string | null;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  storage_key: string;
  created_at: Generated<Date>;
}

export type NotificationType = "new_login" | "subscription" | "security" | "update" | "info";

export interface NotificationsTable {
  id: Generated<string>;
  user_id: string;
  type: NotificationType;
  title: string;
  body: string;
  data: Json<Record<string, unknown>>;
  created_at: Generated<Date>;
  read_at: NullableTimestamp;
}

export interface PreferencesTable {
  user_id: string;
  prefs: Json<Record<string, unknown>>;
}

export interface DB {
  "identity.users": UsersTable;
  "identity.recovery_codes": RecoveryCodesTable;
  "identity.sessions": SessionsTable;
  "identity.email_tokens": EmailTokensTable;
  "ops.devices": DevicesTable;
  "ops.profiles": ProfilesTable;
  "billing.plans": PlansTable;
  "billing.subscriptions": SubscriptionsTable;
  "billing.customers": CustomersTable;
  "billing.invoices": InvoicesTable;
  "billing.payment_methods": PaymentMethodsTable;
  "billing.webhook_events": WebhookEventsTable;
  "fleet.locations": LocationsTable;
  "fleet.servers": ServersTable;
  "fleet.health_samples": HealthSamplesTable;
  "fleet.relay_lists": RelayListsTable;
  "diag.reports": ReportsTable;
  "support.tickets": TicketsTable;
  "support.messages": MessagesTable;
  "support.attachments": AttachmentsTable;
  "notify.notifications": NotificationsTable;
  "notify.preferences": PreferencesTable;
}
