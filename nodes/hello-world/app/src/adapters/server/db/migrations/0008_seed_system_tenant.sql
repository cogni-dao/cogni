-- Seed: system tenant bootstrap data (idempotent)
-- Per docs/spec/system-tenant.md: SYSTEM_TENANT_STARTUP_CHECK
-- All PKs are deterministic UUIDs; human-readable slug stored separately.

-- Set RLS context to the system principal (transaction-local)
SELECT set_config('app.current_user_id', '00000000-0000-4000-a000-000000000001', true);
--> statement-breakpoint

-- Service principal (no wallet — app-level owner, not a user)
INSERT INTO "users" ("id", "wallet_address")
VALUES ('00000000-0000-4000-a000-000000000001', NULL)
ON CONFLICT ("id") DO NOTHING;

-- System tenant billing account (UUID PK + slug for human-friendly lookup)
INSERT INTO "billing_accounts" ("id", "owner_user_id", "is_system_tenant", "slug", "balance_credits", "created_at")
VALUES ('00000000-0000-4000-b000-000000000000', '00000000-0000-4000-a000-000000000001', true, 'cogni_system', 0, now())
ON CONFLICT ("id") DO NOTHING;

-- Default virtual key for system tenant (required by credit_ledger FK)
INSERT INTO "virtual_keys" ("billing_account_id", "label", "is_default", "active")
VALUES ('00000000-0000-4000-b000-000000000000', 'System Default', true, true)
ON CONFLICT DO NOTHING;
