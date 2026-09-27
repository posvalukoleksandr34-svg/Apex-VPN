-- Staff tools: a device limit per account, refunds recorded on invoices,
-- and a record of every staff action.

-- NULL: the plan's limit applies. Set by staff to grant more (or fewer)
-- devices to one account.
ALTER TABLE identity.users ADD COLUMN device_limit_override integer CHECK (device_limit_override BETWEEN 0 AND 100);

ALTER TABLE billing.invoices ADD COLUMN refunded_cents integer NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0);

-- Who did what to which account. Staff actions are account administration,
-- not user activity. When an account is deleted its rows stay, without the
-- link (and the rows hold no email addresses).
CREATE TABLE ops.admin_actions (
  id              bigserial PRIMARY KEY,
  admin_id        uuid REFERENCES identity.users (id) ON DELETE SET NULL,
  target_user_id  uuid REFERENCES identity.users (id) ON DELETE SET NULL,
  action          text NOT NULL CHECK (action IN ('ban', 'unban', 'reset_devices', 'device_limit', 'refund', 'cancel_subscription')),
  detail          jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_actions_target ON ops.admin_actions (target_user_id, created_at DESC);
