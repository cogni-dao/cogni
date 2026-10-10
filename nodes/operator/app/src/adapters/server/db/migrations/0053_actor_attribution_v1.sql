CREATE TABLE "actor_binding_events" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"previous_actor_id" text,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"provider_login" text,
	"event_type" text NOT NULL,
	"authorized_by_actor_id" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actor_binding_events_type_check" CHECK ("actor_binding_events"."event_type" IN ('bound', 'transferred_out', 'transferred_in', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "actor_binding_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "actor_binding_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "actor_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"provider_login" text,
	"evidence_event_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "actor_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "actor_bindings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "actor_beneficiary_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"earned_by_actor_id" text NOT NULL,
	"beneficiary_actor_id" text NOT NULL,
	"policy_version" text NOT NULL,
	"authorized_by_actor_id" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actor_beneficiary_policies_window_check" CHECK ("actor_beneficiary_policies"."effective_to" IS NULL OR "actor_beneficiary_policies"."effective_to" > "actor_beneficiary_policies"."effective_from")
);
--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "actor_contribution_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"epoch_id" bigint NOT NULL,
	"receipt_id" text NOT NULL,
	"contract_version" text NOT NULL,
	"earned_by_actor_id" text NOT NULL,
	"beneficiary_actor_id" text NOT NULL,
	"beneficiary_policy_id" text NOT NULL,
	"beneficiary_policy_version" text NOT NULL,
	"contribution_cutoff" timestamp with time zone NOT NULL,
	"source_evidence" jsonb NOT NULL,
	"source_evidence_hash" text NOT NULL,
	"signer_actor_id" text NOT NULL,
	"signer_wallet" text NOT NULL,
	"signature" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actor_contribution_allocations_contract_check" CHECK ("actor_contribution_allocations"."contract_version" = 'actor.contribution.allocation.v1')
);
--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "actor_binding_events" ADD CONSTRAINT "actor_binding_events_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_binding_events" ADD CONSTRAINT "actor_binding_events_previous_actor_id_actors_id_fk" FOREIGN KEY ("previous_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_binding_events" ADD CONSTRAINT "actor_binding_events_authorized_by_actor_id_actors_id_fk" FOREIGN KEY ("authorized_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_bindings" ADD CONSTRAINT "actor_bindings_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_bindings" ADD CONSTRAINT "actor_bindings_evidence_event_id_actor_binding_events_id_fk" FOREIGN KEY ("evidence_event_id") REFERENCES "public"."actor_binding_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policies" ADD CONSTRAINT "actor_beneficiary_policies_earned_by_actor_id_actors_id_fk" FOREIGN KEY ("earned_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policies" ADD CONSTRAINT "actor_beneficiary_policies_beneficiary_actor_id_actors_id_fk" FOREIGN KEY ("beneficiary_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policies" ADD CONSTRAINT "actor_beneficiary_policies_authorized_by_actor_id_actors_id_fk" FOREIGN KEY ("authorized_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" ADD CONSTRAINT "actor_contribution_allocations_epoch_id_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" ADD CONSTRAINT "actor_contribution_allocations_earned_by_actor_id_actors_id_fk" FOREIGN KEY ("earned_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" ADD CONSTRAINT "actor_contribution_allocations_beneficiary_actor_id_actors_id_fk" FOREIGN KEY ("beneficiary_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" ADD CONSTRAINT "actor_contribution_allocations_beneficiary_policy_id_actor_beneficiary_policies_id_fk" FOREIGN KEY ("beneficiary_policy_id") REFERENCES "public"."actor_beneficiary_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" ADD CONSTRAINT "actor_contribution_allocations_signer_actor_id_actors_id_fk" FOREIGN KEY ("signer_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "actor_binding_events_source_idx" ON "actor_binding_events" USING btree ("provider","external_id","effective_at");--> statement-breakpoint
CREATE INDEX "actor_binding_events_actor_id_idx" ON "actor_binding_events" USING btree ("actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "actor_bindings_active_source_unique" ON "actor_bindings" USING btree ("provider","external_id") WHERE "actor_bindings"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "actor_bindings_actor_id_idx" ON "actor_bindings" USING btree ("actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "actor_beneficiary_policies_version_unique" ON "actor_beneficiary_policies" USING btree ("earned_by_actor_id","policy_version");--> statement-breakpoint
CREATE UNIQUE INDEX "actor_beneficiary_policies_effective_from_unique" ON "actor_beneficiary_policies" USING btree ("earned_by_actor_id","effective_from");--> statement-breakpoint
CREATE INDEX "actor_beneficiary_policies_effective_idx" ON "actor_beneficiary_policies" USING btree ("earned_by_actor_id","effective_from","effective_to");--> statement-breakpoint
CREATE UNIQUE INDEX "actor_contribution_allocations_receipt_version_unique" ON "actor_contribution_allocations" USING btree ("node_id","epoch_id","receipt_id","contract_version");--> statement-breakpoint
CREATE INDEX "actor_contribution_allocations_beneficiary_idx" ON "actor_contribution_allocations" USING btree ("beneficiary_actor_id","epoch_id");--> statement-breakpoint

-- Backfill legacy human ownership into the canonical actor registry. Billing is
-- only the actor schema's tenancy requirement; it never selects ownership or beneficiary.
INSERT INTO "billing_accounts" ("id", "owner_user_id", "balance_credits")
SELECT gen_random_uuid()::text, ub."user_id", 0
FROM (SELECT DISTINCT "user_id" FROM "user_bindings") ub
LEFT JOIN "billing_accounts" ba ON ba."owner_user_id" = ub."user_id"
WHERE ba."id" IS NULL;
--> statement-breakpoint
INSERT INTO "actors" ("id", "kind", "user_id", "billing_account_id")
SELECT gen_random_uuid()::text, 'user', ub."user_id", ba."id"
FROM (SELECT DISTINCT "user_id" FROM "user_bindings") ub
JOIN "billing_accounts" ba ON ba."owner_user_id" = ub."user_id"
LEFT JOIN "actors" a ON a."user_id" = ub."user_id"
WHERE a."id" IS NULL;
--> statement-breakpoint
INSERT INTO "actor_binding_events" (
  "id", "actor_id", "provider", "external_id", "provider_login",
  "event_type", "authorized_by_actor_id", "evidence", "effective_at", "created_at"
)
SELECT
  'legacy-user-binding-event:' || ub."id", a."id", ub."provider", ub."external_id",
  ub."provider_login", 'bound', a."id",
  jsonb_build_object('migration', '0053', 'legacyUserBindingId', ub."id"),
  ub."created_at", ub."created_at"
FROM "user_bindings" ub
JOIN "actors" a ON a."user_id" = ub."user_id";
--> statement-breakpoint
INSERT INTO "actor_bindings" (
  "id", "actor_id", "provider", "external_id", "provider_login",
  "evidence_event_id", "created_at"
)
SELECT
  'legacy-user-binding:' || ub."id", a."id", ub."provider", ub."external_id",
  ub."provider_login", 'legacy-user-binding-event:' || ub."id", ub."created_at"
FROM "user_bindings" ub
JOIN "actors" a ON a."user_id" = ub."user_id";
--> statement-breakpoint

-- Legacy user_bindings is now a guarded compatibility projection. Direct old
-- writers atomically establish canonical ownership first; a conflicting AI or
-- human owner raises via actor_bindings_active_source_unique.
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
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER user_bindings_canonical_owner
BEFORE INSERT OR UPDATE ON "user_bindings"
FOR EACH ROW EXECUTE FUNCTION project_user_binding_to_actor_owner();
--> statement-breakpoint
CREATE TRIGGER actor_binding_events_append_only
  BEFORE UPDATE OR DELETE ON "actor_binding_events"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER actor_beneficiary_policies_append_only
  BEFORE UPDATE OR DELETE ON "actor_beneficiary_policies"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER actor_contribution_allocations_append_only
  BEFORE UPDATE OR DELETE ON "actor_contribution_allocations"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
