/** Shapes the account API answers with (see docs/openapi.json). */

export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  locale: string;
  mfaEnabled: boolean;
  role: "user" | "admin";
  createdAt: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
  user: User;
}

export type LoginResponse = TokenResponse | { mfaRequired: true; mfaToken: string };

export type SubscriptionStatus = "none" | "incomplete" | "trialing" | "active" | "past_due" | "canceled" | "expired";

export interface Plan {
  id: string;
  name: string;
  period: "trial" | "month" | "year";
  priceCents: number;
  currency: string;
  deviceLimit: number;
}

export interface Subscription {
  status: SubscriptionStatus;
  plan: Plan | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  provider: string | null;
  paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null;
  devicesUsed: number;
  /** Devices this account may register (a staff-set limit, else the plan's). */
  deviceLimit: number | null;
}

export interface Invoice {
  id: string;
  number: string;
  description: string;
  amountCents: number;
  currency: string;
  status: string;
  issuedAt: string;
  paidAt: string | null;
}

export const DEVICE_PLATFORMS = ["ios", "android", "windows", "macos", "linux", "router", "other"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export interface Device {
  id: string;
  name: string;
  platform: string;
  appVersion: string | null;
  publicKey: string;
  ipv4Address: string;
  ipv6Address: string | null;
  createdAt: string;
  lastSeenOn: string;
  connected: boolean;
  connectedServerId: string | null;
}

export interface Registration {
  deviceId: string;
  publicKey: string;
  ipv4Address: string;
  ipv6Address: string | null;
  validUntil: number | null;
}

export interface SessionInfo {
  id: string;
  deviceName: string;
  platform: string;
  createdAt: string;
  lastUsedOn: string;
  current: boolean;
}

export interface RelayLocation {
  id: string;
  countryCode: string;
  country: string;
  city: string;
}

export interface RelayServer {
  id: string;
  hostname: string;
  locationId: string;
  status: "online" | "busy" | "maintenance" | "offline";
  load: number | null;
  capacity: number;
  features: string[];
  ipv4: string;
  ipv6: string | null;
  wireguard: {
    publicKey: string;
    ports: number[];
    gatewayIpv4: string;
    gatewayIpv6: string | null;
    dnsIpv4: string | null;
  } | null;
}

export interface RelayList {
  version: number;
  generatedAt: number;
  expiresAt: number;
  locations: RelayLocation[];
  servers: RelayServer[];
}

/* Staff tools (/v1/admin). */

export const ADMIN_FILTERS = ["all", "active", "trialing", "past_due", "canceled", "expired", "none", "banned", "admins"] as const;
export type AdminFilter = (typeof ADMIN_FILTERS)[number];

export interface AdminUser {
  id: string;
  email: string;
  role: "user" | "admin";
  isBanned: boolean;
  emailVerified: boolean;
  mfaEnabled: boolean;
  createdAt: string;
  devices: number;
  deviceLimit: number | null;
  deviceLimitOverride: number | null;
  subscription: {
    status: Exclude<SubscriptionStatus, "none">;
    planId: string;
    planName: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    provider: string;
  } | null;
}

export interface AdminUserPage {
  total: number;
  page: number;
  pageSize: number;
  users: AdminUser[];
}

export interface AdminInvoice {
  id: string;
  number: string;
  description: string;
  amountCents: number;
  refundedCents: number;
  currency: string;
  status: string;
  issuedAt: string;
  refundable: boolean;
}

export interface AdminAction {
  id: string;
  action: "ban" | "unban" | "reset_devices" | "device_limit" | "refund" | "cancel_subscription";
  detail: Record<string, unknown>;
  adminEmail: string | null;
  createdAt: string;
}

export interface AdminUserDetail {
  user: AdminUser;
  stripeCustomerUrl: string | null;
  devices: { id: string; name: string; platform: string; createdAt: string; lastSeenOn: string; connected: boolean }[];
  invoices: AdminInvoice[];
  actions: AdminAction[];
}
