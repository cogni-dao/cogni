CREATE TABLE "existing_agent_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"steward_actor_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"provider_login" text,
	"attestation_jti" text NOT NULL,
	"attestation_evidence" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending_ai_acceptance' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "existing_agent_claims_attestation_jti_unique" UNIQUE("attestation_jti"),
	CONSTRAINT "existing_agent_claims_provider_check" CHECK ("existing_agent_claims"."provider" = 'github'),
	CONSTRAINT "existing_agent_claims_status_check" CHECK ("existing_agent_claims"."status" IN ('pending_ai_acceptance', 'accepted', 'expired', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "existing_agent_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policy_acceptances" DROP CONSTRAINT "actor_beneficiary_policy_acceptances_role_check";--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" DROP CONSTRAINT "actor_contribution_allocations_signer_actor_id_actors_id_fk";
--> statement-breakpoint
ALTER TABLE "actor_distribution_liabilities" DROP CONSTRAINT "actor_distribution_liabilities_signer_actor_id_actors_id_fk";
--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" ALTER COLUMN "beneficiary_actor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" ALTER COLUMN "beneficiary_policy_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" ALTER COLUMN "beneficiary_policy_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "actor_distribution_liabilities" ALTER COLUMN "beneficiary_actor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "existing_agent_claims" ADD CONSTRAINT "existing_agent_claims_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "existing_agent_claims" ADD CONSTRAINT "existing_agent_claims_steward_actor_id_actors_id_fk" FOREIGN KEY ("steward_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "existing_agent_claims_steward_idempotency_unique" ON "existing_agent_claims" USING btree ("steward_actor_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "existing_agent_claims_actor_status_idx" ON "existing_agent_claims" USING btree ("actor_id","status");--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" DROP COLUMN "signer_actor_id";--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" DROP COLUMN "signer_wallet";--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" DROP COLUMN "signature";--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" DROP COLUMN "signed_at";--> statement-breakpoint
ALTER TABLE "actor_distribution_liabilities" DROP COLUMN "signer_actor_id";--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policy_acceptances" ADD CONSTRAINT "actor_beneficiary_policy_acceptances_role_check" CHECK ("actor_beneficiary_policy_acceptances"."role" IN ('beneficiary', 'earner', 'steward', 'governance_for_earner', 'governance_for_steward'));--> statement-breakpoint

-- 0055 intentionally created billing accounts before the account service
-- existed. Repair those rows forward so account lookup cannot enter the
-- existing-account/no-default-key dead end.
INSERT INTO "virtual_keys" ("billing_account_id", "label", "is_default", "active")
SELECT ba."id", 'Default', true, true
FROM "billing_accounts" ba
WHERE NOT EXISTS (
  SELECT 1
  FROM "virtual_keys" vk
  WHERE vk."billing_account_id" = ba."id"
    AND vk."is_default" = true
);--> statement-breakpoint

-- Keep the compatibility trigger safe for writes that arrive after this
-- migration. The canonical account and its default billing key are created in
-- the same transaction; consumers can never observe the 0055 half-state.
CREATE OR REPLACE FUNCTION project_user_binding_to_actor_owner()
RETURNS trigger AS $$
DECLARE
  owner_actor_id text;
  billing_id text;
  evidence_id text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('actor-binding:' || NEW.provider || ':' || NEW.external_id));

  SELECT ab.actor_id INTO owner_actor_id
  FROM actor_bindings ab
  JOIN actors a ON a.id = ab.actor_id
  WHERE ab.provider = NEW.provider
    AND ab.external_id = NEW.external_id
    AND ab.closed_at IS NULL
    AND a.kind = 'user'
    AND a.user_id = NEW.user_id;

  IF owner_actor_id IS NULL THEN
    SELECT id INTO billing_id FROM billing_accounts WHERE owner_user_id = NEW.user_id;
    IF billing_id IS NULL THEN
      billing_id := gen_random_uuid()::text;
      INSERT INTO billing_accounts (id, owner_user_id, balance_credits)
      VALUES (billing_id, NEW.user_id, 0)
      ON CONFLICT (owner_user_id) DO NOTHING;
      SELECT id INTO billing_id FROM billing_accounts WHERE owner_user_id = NEW.user_id;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('billing-default-key:' || billing_id));
    INSERT INTO virtual_keys (billing_account_id, label, is_default, active)
    SELECT billing_id, 'Default', true, true
    WHERE NOT EXISTS (
      SELECT 1 FROM virtual_keys
      WHERE billing_account_id = billing_id AND is_default = true
    );

    PERFORM pg_advisory_xact_lock(hashtext('human-actor:' || NEW.user_id));
    SELECT id INTO owner_actor_id FROM actors WHERE kind = 'user' AND user_id = NEW.user_id;
    IF owner_actor_id IS NULL THEN
      owner_actor_id := gen_random_uuid()::text;
      INSERT INTO actors (id, kind, user_id, billing_account_id)
      VALUES (owner_actor_id, 'user', NEW.user_id, billing_id);
    END IF;

    evidence_id := gen_random_uuid()::text;
    INSERT INTO actor_binding_events (
      id, actor_id, provider, external_id, provider_login, event_type,
      authorized_by_actor_id, evidence, effective_at
    ) VALUES (
      evidence_id, owner_actor_id, NEW.provider, NEW.external_id,
      NEW.provider_login, 'bound', owner_actor_id,
      jsonb_build_object('compatibilityProjection', 'user_bindings'), NEW.created_at
    );
    INSERT INTO actor_bindings (
      id, actor_id, provider, external_id, provider_login, evidence_event_id, created_at
    ) VALUES (
      gen_random_uuid()::text, owner_actor_id, NEW.provider, NEW.external_id,
      NEW.provider_login, evidence_id, NEW.created_at
    );
  ELSIF TG_OP = 'UPDATE' AND NEW.provider_login IS DISTINCT FROM OLD.provider_login THEN
    UPDATE actor_bindings
    SET provider_login = NEW.provider_login
    WHERE provider = NEW.provider AND external_id = NEW.external_id AND closed_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

ALTER TABLE "existing_agent_claims" FORCE ROW LEVEL SECURITY;
