-- Account roles and bans, paid-plan device limit, and hardening for hosting
-- on Supabase.

-- ── roles and bans ──────────────────────────────────────────────────────

ALTER TABLE identity.users ADD COLUMN role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'));
ALTER TABLE identity.users ADD COLUMN is_banned boolean NOT NULL DEFAULT false;
-- is_banned replaces the two-valued status column (one source of truth).
UPDATE identity.users SET is_banned = true WHERE status = 'disabled';
ALTER TABLE identity.users DROP COLUMN status;

-- A ban takes effect at once, however it's made (including plain SQL):
-- every session is revoked, so no refresh succeeds; access tokens are
-- refused on their next use (auth checks is_banned per request) and the
-- nodes drop the user's peers at their next sync.
CREATE FUNCTION identity.revoke_sessions_on_ban() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_banned AND NOT OLD.is_banned THEN
    UPDATE identity.sessions
       SET revoked_at = now(), revoked_reason = 'banned'
     WHERE user_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_ban_revokes_sessions
  AFTER UPDATE OF is_banned ON identity.users
  FOR EACH ROW EXECUTE FUNCTION identity.revoke_sessions_on_ban();

-- ── device limits ───────────────────────────────────────────────────────

-- Paid plans allow 5 devices (the trial keeps 2). Limits stay per plan.
UPDATE billing.plans SET device_limit = 5 WHERE id IN ('monthly', 'annual');

-- ── Supabase ────────────────────────────────────────────────────────────

-- On Supabase, the `anon` and `authenticated` roles back its public
-- auto-generated API. Nothing here is meant to be reached that way (the
-- API server is the only client), so they get no access to any schema this
-- product uses, including tables created later. Elsewhere those roles don't
-- exist and this block does nothing.
DO $$
DECLARE
  r text;
  s text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH s IN ARRAY ARRAY['identity', 'billing', 'fleet', 'ops', 'diag', 'support', 'notify'] LOOP
        EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', s, r);
        EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', s, r);
        EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM %I', s, r);
        EXECUTE format('REVOKE USAGE ON SCHEMA %I FROM %I', s, r);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM %I', s, r);
      END LOOP;
      EXECUTE format('REVOKE ALL ON TABLE public.schema_migrations FROM %I', r);
    END IF;
  END LOOP;
END;
$$;
