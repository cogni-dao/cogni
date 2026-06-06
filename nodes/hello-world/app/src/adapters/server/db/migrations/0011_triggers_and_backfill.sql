-- Triggers and backfill for identity + ledger tables.
-- Depends on 0010 DDL. Idempotent: safe to rerun.
--
-- 1. ledger_reject_mutation()  — shared reject function for append-only tables
-- 2. identity_events trigger   — APPEND_ONLY_EVENTS
-- 3. activity_events trigger   — ACTIVITY_APPEND_ONLY
-- 4. epoch_pool_components trigger — POOL_IMMUTABLE
-- 5. curation_freeze_on_finalize()  — CURATION_FREEZE_ON_FINALIZE
-- 6. Wallet backfill             — seed user_bindings from existing users

-- ── Shared reject-mutation function ─────────────────────────────────
CREATE OR REPLACE FUNCTION ledger_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% not allowed on %', TG_OP, TG_TABLE_NAME;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ── Identity: append-only trigger ───────────────────────────────────
DROP TRIGGER IF EXISTS identity_events_append_only ON "identity_events";--> statement-breakpoint
CREATE TRIGGER identity_events_append_only
  BEFORE UPDATE OR DELETE ON "identity_events"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();--> statement-breakpoint

-- ── Ledger: append-only triggers ────────────────────────────────────
DROP TRIGGER IF EXISTS activity_events_immutable ON "activity_events";--> statement-breakpoint
CREATE TRIGGER activity_events_immutable
  BEFORE UPDATE OR DELETE ON "activity_events"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();--> statement-breakpoint

DROP TRIGGER IF EXISTS epoch_pool_components_immutable ON "epoch_pool_components";--> statement-breakpoint
CREATE TRIGGER epoch_pool_components_immutable
  BEFORE UPDATE OR DELETE ON "epoch_pool_components"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();--> statement-breakpoint

-- ── Curation freeze: reject writes when epoch is finalized ─────────────
CREATE OR REPLACE FUNCTION curation_freeze_on_finalize() RETURNS trigger AS $$
DECLARE
  epoch_status text;
BEGIN
  -- For DELETE, use OLD; for INSERT/UPDATE, use NEW
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO epoch_status FROM epochs WHERE id = OLD.epoch_id;
  ELSE
    SELECT status INTO epoch_status FROM epochs WHERE id = NEW.epoch_id;
  END IF;

  IF epoch_status = 'finalized' THEN
    RAISE EXCEPTION 'Cannot % activity_curation: epoch % is finalized', TG_OP, COALESCE(NEW.epoch_id::text, OLD.epoch_id::text);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS activity_curation_freeze ON "activity_curation";--> statement-breakpoint
CREATE TRIGGER activity_curation_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON "activity_curation"
  FOR EACH ROW EXECUTE FUNCTION curation_freeze_on_finalize();--> statement-breakpoint

-- ── Identity backfill: seed user_bindings from existing wallet users ─
-- Idempotent: ON CONFLICT skips already-bound wallets.
-- Only emits identity_events for actually-inserted bindings.
WITH inserted AS (
  INSERT INTO user_bindings (id, user_id, provider, external_id, created_at)
  SELECT
    gen_random_uuid()::text,
    u.id,
    'wallet',
    u.wallet_address,
    NOW()
  FROM users u
  WHERE u.wallet_address IS NOT NULL
  ON CONFLICT (provider, external_id) DO NOTHING
  RETURNING user_id, provider, external_id
)
INSERT INTO identity_events (id, user_id, event_type, payload, created_at)
SELECT
  gen_random_uuid()::text,
  i.user_id,
  'bind',
  jsonb_build_object('provider', i.provider, 'external_id', i.external_id, 'method', 'backfill:v0-migration'),
  NOW()
FROM inserted i;
