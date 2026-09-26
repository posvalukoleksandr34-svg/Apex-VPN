-- Production billing on Stripe.

-- One provider customer per user (Stripe `cus_…`), so repeat purchases,
-- invoices and the billing portal all belong to the same customer.
CREATE TABLE billing.customers (
  user_id      uuid NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  provider     text NOT NULL,
  customer_ref text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);
CREATE UNIQUE INDEX customers_ref ON billing.customers (provider, customer_ref);

-- Which Stripe price sells each plan (set from STRIPE_PRICE_<PLAN> at
-- start). Also maps a subscription's price back to our plan when the
-- customer changes plans in the billing portal.
ALTER TABLE billing.plans ADD COLUMN stripe_price_id text;
CREATE UNIQUE INDEX plans_stripe_price ON billing.plans (stripe_price_id) WHERE stripe_price_id IS NOT NULL;

-- "incomplete": created at checkout, first payment not yet confirmed.
-- It grants no access (see entitlement.ts).
ALTER TABLE billing.subscriptions DROP CONSTRAINT subscriptions_status_check;
ALTER TABLE billing.subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('incomplete', 'trialing', 'active', 'past_due', 'canceled', 'expired'));

-- When the provider state in this row was read. Webhook deliveries can
-- race; an older read never overwrites a newer one.
ALTER TABLE billing.subscriptions ADD COLUMN provider_synced_at timestamptz;
CREATE UNIQUE INDEX subscriptions_provider_ref ON billing.subscriptions (provider, provider_ref) WHERE provider_ref IS NOT NULL;

-- Provider invoices are recorded once, however often the webhook arrives.
CREATE UNIQUE INDEX invoices_provider_ref ON billing.invoices (provider_ref) WHERE provider_ref IS NOT NULL;
ALTER TABLE billing.invoices ADD COLUMN hosted_url text;

ALTER TABLE billing.payment_methods ADD CONSTRAINT payment_methods_user_provider UNIQUE (user_id, provider);

ALTER TABLE billing.webhook_events ADD COLUMN event_type text;
