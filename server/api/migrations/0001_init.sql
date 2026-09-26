-- Meridian initial schema.
--
-- One PostgreSQL schema per domain, so access can be granted per domain
-- (e.g. support staff tooling never gets `identity` or `billing`):
--   identity  accounts, credentials, sessions, MFA
--   ops       devices and their tunnel addresses, synced profiles
--   billing   plans, subscriptions, invoices (provider references only)
--   fleet     locations, servers, health samples, signed relay lists
--   diag      diagnostic reports users chose to send
--   support   tickets, messages, attachments
--   notify    in-app notifications and preferences
--
-- Deliberately absent anywhere: traffic, visited hosts, DNS queries, per-user
-- connection history, source IPs of tunnel sessions.
--
-- gen_random_uuid() is built into PostgreSQL 13+; no extension needed.


CREATE SCHEMA identity;
CREATE SCHEMA ops;
CREATE SCHEMA billing;
CREATE SCHEMA fleet;
CREATE SCHEMA diag;
CREATE SCHEMA support;
CREATE SCHEMA notify;

-- ── identity ────────────────────────────────────────────────────────────

CREATE TABLE identity.users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  password_hash     text NOT NULL,
  email_verified_at timestamptz,
  locale            text NOT NULL DEFAULT 'en',
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  totp_secret_enc   text,
  totp_enabled_at   timestamptz,
  totp_last_step    bigint,
  failed_logins     integer NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON identity.users (lower(email));

CREATE TABLE identity.recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz
);
CREATE INDEX recovery_codes_user ON identity.recovery_codes (user_id);

-- Refresh tokens are stored as SHA-256 hashes. `family_id` links every
-- rotation of one sign-in, so reuse of a rotated token revokes the family.
CREATE TABLE identity.sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  family_id      uuid NOT NULL,
  refresh_hash   text NOT NULL UNIQUE,
  device_name    text NOT NULL DEFAULT 'Unknown device',
  platform       text NOT NULL DEFAULT 'unknown',
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_on   date NOT NULL DEFAULT current_date,
  expires_at     timestamptz NOT NULL,
  rotated_at     timestamptz,
  revoked_at     timestamptz,
  revoked_reason text
);
CREATE INDEX sessions_user ON identity.sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_family ON identity.sessions (family_id);

CREATE TABLE identity.email_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  code_hash  text NOT NULL,
  attempts   integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_tokens_lookup ON identity.email_tokens (user_id, purpose) WHERE used_at IS NULL;

-- ── ops ─────────────────────────────────────────────────────────────────

-- Device addresses are allocated sequentially from 10.64.0.0/10 and
-- fc00:bbbb:bbbb:bb01::/64 and never reused (4 million+ addresses).
CREATE SEQUENCE ops.device_address_seq START 2;

CREATE TABLE ops.devices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  name           text NOT NULL,
  platform       text NOT NULL CHECK (platform IN ('windows', 'macos', 'linux', 'other')),
  app_version    text,
  wg_public_key  text NOT NULL,
  ipv4           inet NOT NULL,
  ipv6           inet,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_on   date NOT NULL DEFAULT current_date,
  revoked_at     timestamptz
);
CREATE UNIQUE INDEX devices_key ON ops.devices (wg_public_key) WHERE revoked_at IS NULL;
-- Unique among active devices; a revoked device's address is never reissued
-- by the sequential pool, but the development demo server may reuse its own.
CREATE UNIQUE INDEX devices_ipv4 ON ops.devices (ipv4) WHERE revoked_at IS NULL;
CREATE INDEX devices_user ON ops.devices (user_id) WHERE revoked_at IS NULL;

CREATE TABLE ops.profiles (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  name       text NOT NULL,
  kind       text NOT NULL,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profiles_user ON ops.profiles (user_id);

-- ── billing ─────────────────────────────────────────────────────────────

CREATE TABLE billing.plans (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  period       text NOT NULL CHECK (period IN ('trial', 'month', 'year')),
  price_cents  integer NOT NULL,
  currency     text NOT NULL,
  device_limit integer NOT NULL,
  active       boolean NOT NULL DEFAULT true
);

CREATE TABLE billing.subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL UNIQUE REFERENCES identity.users (id) ON DELETE CASCADE,
  plan_id              text NOT NULL REFERENCES billing.plans (id),
  status               text NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'expired')),
  current_period_start timestamptz NOT NULL,
  current_period_end   timestamptz NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  provider             text NOT NULL,
  provider_ref         text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billing.invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES billing.subscriptions (id) ON DELETE SET NULL,
  number          text NOT NULL UNIQUE,
  description     text NOT NULL,
  amount_cents    integer NOT NULL,
  currency        text NOT NULL,
  status          text NOT NULL CHECK (status IN ('paid', 'open', 'void', 'refunded')),
  issued_at       timestamptz NOT NULL DEFAULT now(),
  paid_at         timestamptz,
  provider_ref    text
);
CREATE INDEX invoices_user ON billing.invoices (user_id, issued_at DESC);

-- Display metadata only; card data never touches our systems.
CREATE TABLE billing.payment_methods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  provider     text NOT NULL,
  provider_ref text NOT NULL,
  brand        text NOT NULL,
  last4        text NOT NULL,
  exp_month    integer NOT NULL,
  exp_year     integer NOT NULL,
  is_default   boolean NOT NULL DEFAULT true
);

CREATE TABLE billing.webhook_events (
  provider    text NOT NULL,
  event_id    text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

INSERT INTO billing.plans (id, name, period, price_cents, currency, device_limit) VALUES
  ('trial',   'Free trial', 'trial',    0, 'EUR', 2),
  ('monthly', 'Monthly',    'month',  999, 'EUR', 10),
  ('annual',  'Annual',     'year',  5999, 'EUR', 10);

-- ── fleet ───────────────────────────────────────────────────────────────

CREATE TABLE fleet.locations (
  id           text PRIMARY KEY,
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  country      text NOT NULL,
  city         text NOT NULL,
  latitude     double precision NOT NULL,
  longitude    double precision NOT NULL
);

CREATE TABLE fleet.servers (
  id                text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  hostname          text NOT NULL UNIQUE,
  location_id       text NOT NULL REFERENCES fleet.locations (id),
  ipv4              inet NOT NULL,
  ipv6              inet,
  status            text NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'busy', 'maintenance', 'offline')),
  capacity          integer NOT NULL DEFAULT 500,
  features          text[] NOT NULL DEFAULT '{}',
  wg_public_key     text,
  wg_ports          integer[] NOT NULL DEFAULT '{51820}',
  wg_gateway_ipv4   inet,
  wg_gateway_ipv6   inet,
  node_token_hash   text,
  -- TCP port the fleet monitor probes for reachability (the node agent's
  -- health port; WireGuard itself is UDP and can't be probed).
  monitor_tcp_port  integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Kept 7 days. Only measured values; the relay list publishes a value only
-- while its latest sample is fresh.
CREATE TABLE fleet.health_samples (
  id           bigserial PRIMARY KEY,
  server_id    text NOT NULL REFERENCES fleet.servers (id) ON DELETE CASCADE,
  source       text NOT NULL CHECK (source IN ('monitor', 'node')),
  measured_at  timestamptz NOT NULL DEFAULT now(),
  reachable    boolean,
  rtt_ms       integer,
  packet_loss  real,
  active_peers integer,
  wg_healthy   boolean
);
CREATE INDEX health_samples_recent ON fleet.health_samples (server_id, measured_at DESC);

CREATE TABLE fleet.relay_lists (
  version      bigserial PRIMARY KEY,
  generated_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  payload      text NOT NULL,
  signature    text NOT NULL,
  key_id       text NOT NULL
);

-- ── diag ────────────────────────────────────────────────────────────────

CREATE TABLE diag.reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES identity.users (id) ON DELETE SET NULL,
  app_version text,
  os          text,
  report      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── support ─────────────────────────────────────────────────────────────

CREATE SEQUENCE support.ticket_number_seq START 1000;

CREATE TABLE support.tickets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number               integer NOT NULL UNIQUE DEFAULT nextval('support.ticket_number_seq'),
  user_id              uuid NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  subject              text NOT NULL,
  category             text NOT NULL CHECK (category IN ('connection', 'billing', 'account', 'privacy', 'other')),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  diagnostic_report_id uuid REFERENCES diag.reports (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tickets_user ON support.tickets (user_id, created_at DESC);

CREATE TABLE support.messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  uuid NOT NULL REFERENCES support.tickets (id) ON DELETE CASCADE,
  author     text NOT NULL CHECK (author IN ('user', 'staff')),
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE support.attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    uuid NOT NULL REFERENCES support.tickets (id) ON DELETE CASCADE,
  message_id   uuid REFERENCES support.messages (id) ON DELETE CASCADE,
  filename     text NOT NULL,
  content_type text NOT NULL,
  size_bytes   integer NOT NULL,
  sha256       text NOT NULL,
  storage_key  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── notify ──────────────────────────────────────────────────────────────

CREATE TABLE notify.notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN ('new_login', 'subscription', 'security', 'update', 'info')),
  title      text NOT NULL,
  body       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE INDEX notifications_user ON notify.notifications (user_id, created_at DESC);

CREATE TABLE notify.preferences (
  user_id uuid PRIMARY KEY REFERENCES identity.users (id) ON DELETE CASCADE,
  prefs   jsonb NOT NULL DEFAULT '{}'
);
