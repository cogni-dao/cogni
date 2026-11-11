-- 0063 owns agent_credentials on the operator. No migration on main creates this table (main's ledger ends at 0062), so on a fresh
-- database and on production the DROP below is a no-op. It exists for ONE database: the operator candidate database, where an
-- `agent_credentials` table already exists. That table is a leak from draft PR #2784 (story.5075): its migration 0055_closed_darwin
-- created agent_credentials alongside the actors/* tables, and a flight of that draft applied it there (drizzle records migrations by
-- HASH, not index, so the old-numbered leak coexists with main's later 0055-0062). It has a different column set and no 0063 ledger
-- row, so CREATE TABLE below fails on it (observed live: candidate migrate container, PostgresError 42P07, 2026-11-11 ~18:0xZ).
-- CASCADE removes only that table with its own indexes and constraints: #2784's sibling tables (agent_spawn_grants,
-- agent_recovery_grants, actors/*) reference it only via their own FKs, which CASCADE detaches; they stay, same as node-template's
-- 0039 left its #204 siblings. This mirrors node-template 0039's CEO-approved remediation of the identical class
-- (https://github.com/cogni-dao/node-template/pull/303, recorded on story.5147); the operator instance is recorded on
-- https://cognidao.org/work/items/story.5156. Once any database applies 0063, it is immutable.
DROP TABLE IF EXISTS "agent_credentials" CASCADE;--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_from" text NOT NULL,
	"predecessor_id" uuid,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"renew_until" timestamp with time zone NOT NULL,
	"pending_expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"revoked_by" text,
	CONSTRAINT "agent_credentials_created_from_canonical" CHECK ("agent_credentials"."created_from" IN ('spawn_grant','rotation','key_upgrade','binding_recovery','recovery_grant')),
	CONSTRAINT "agent_credentials_renew_after_expiry" CHECK ("agent_credentials"."renew_until" > "agent_credentials"."expires_at")
);
--> statement-breakpoint
ALTER TABLE "agent_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"slug" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_principals_kind_canonical" CHECK ("agent_principals"."kind" IN ('internal','external')),
	CONSTRAINT "agent_principals_internal_has_slug" CHECK ("agent_principals"."kind" <> 'internal' OR "agent_principals"."slug" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "agent_principals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"principal_user_id" text NOT NULL,
	"scope" text NOT NULL,
	"approved_by" text,
	"granted_at" timestamp with time zone,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_predecessor_id_fk" FOREIGN KEY ("predecessor_id") REFERENCES "public"."agent_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD CONSTRAINT "agent_principals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_principal_user_id_users_id_fk" FOREIGN KEY ("principal_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_token_hash_unique" ON "agent_credentials" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_one_pending_successor" ON "agent_credentials" USING btree ("predecessor_id") WHERE "agent_credentials"."confirmed_at" IS NULL AND "agent_credentials"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agent_credentials_user_idx" ON "agent_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_principals_slug_unique" ON "agent_principals" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_principals_user_id_unique" ON "agent_principals" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_roles_live_unique" ON "agent_roles" USING btree ("principal_user_id","scope") WHERE "agent_roles"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agent_roles_principal_idx" ON "agent_roles" USING btree ("principal_user_id");--> statement-breakpoint
CREATE POLICY "agent_principals_read" ON "agent_principals" AS PERMISSIVE FOR SELECT TO public USING (true);
--> statement-breakpoint
-- Hand-written below (parity with node-template 0036 + 0039 + 0040 final shape): FORCE RLS, functions and triggers are outside Drizzle's DDL
-- scope. agent_credentials and agent_roles have NO policy: ENABLE + FORCE = deny-all for the app role; only the BYPASSRLS service role
-- reads or writes them. agent_principals is readable by all roles (its select policy), writable only by the service role.
ALTER TABLE "agent_principals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_roles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- AGENTS_HOLD_NO_WALLET (a payout guard: no user-centric payout reaches an AI), enforced in the database on every binding path: a user
-- that has an agent_principals row can never bind a wallet. A kind-based payout guard, not an admin rule.
CREATE OR REPLACE FUNCTION agent_principals_refuse_wallet_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.provider = 'wallet'
     AND EXISTS (SELECT 1 FROM agent_principals ap WHERE ap.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'agent principal % cannot bind a wallet', NEW.user_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agent_principals_no_wallet_binding';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_principals_no_wallet_binding" ON "user_bindings";--> statement-breakpoint
CREATE TRIGGER "agent_principals_no_wallet_binding"
  BEFORE INSERT OR UPDATE OF user_id, provider ON "user_bindings"
  FOR EACH ROW EXECUTE FUNCTION agent_principals_refuse_wallet_binding();--> statement-breakpoint
-- STATE_IS_DERIVED: the one derivation of a credential's state from its timestamps, against the DATABASE clock. Never stored.
CREATE OR REPLACE FUNCTION agent_credential_state(c agent_credentials)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN c.revoked_at IS NOT NULL THEN 'revoked'
    WHEN c.confirmed_at IS NULL THEN CASE WHEN c.pending_expires_at > now() THEN 'pending' ELSE 'pending_expired' END
    WHEN c.expires_at > now() THEN 'active'
    WHEN c.renew_until > now() THEN 'renew_only'
    ELSE 'expired'
  END
$$;--> statement-breakpoint
-- CREDENTIALS_ONLY_ON_AGENT_PRINCIPALS: a credential may belong only to a user with an EXTERNAL agent_principals row. An internal
-- principal (this node's AI) never holds a key, and a plain user has no agent row until `upgrade` writes one.
CREATE OR REPLACE FUNCTION agent_credentials_require_external_principal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM agent_principals ap WHERE ap.user_id = NEW.user_id AND ap.kind = 'external') THEN
    RAISE EXCEPTION 'agent credential for % requires an external agent principal', NEW.user_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agent_credentials_external_principal_only';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_credentials_external_principal_only" ON "agent_credentials";--> statement-breakpoint
CREATE TRIGGER "agent_credentials_external_principal_only"
  BEFORE INSERT OR UPDATE OF user_id ON "agent_credentials"
  FOR EACH ROW EXECUTE FUNCTION agent_credentials_require_external_principal();
