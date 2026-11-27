-- Operator-owned catalog identities (story.0085 / compat story.0086).
-- Drizzle --custom generated this migration's journal and snapshot; drizzle cannot emit seed data.
-- These are NEW node-local users, not imported surrogate IDs or adopted legacy users.
-- A conflicting slug fails the migration rather than reclassifying an existing principal.
-- No credentials, roles, wallets, payout bindings or billing accounts are created.
-- Permission approval stays with the existing DAO/admin authority. Existing payout guards stay intact.
-- The table owner temporarily lifts FORCE RLS inside the migration transaction, then restores it.
ALTER TABLE "users" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_principals" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE
  principal_slug text;
  principal_user_id text;
BEGIN
  FOREACH principal_slug IN ARRAY ARRAY['node-ai', 'prioritizer', 'operating-review']
  LOOP
    principal_user_id := gen_random_uuid()::text;
    INSERT INTO "users" ("id", "name") VALUES (principal_user_id, principal_slug);
    INSERT INTO "agent_principals" ("kind", "slug", "user_id")
      VALUES ('internal', principal_slug, principal_user_id);
  END LOOP;
END
$$;--> statement-breakpoint
ALTER TABLE "agent_principals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
