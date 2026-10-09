CREATE TABLE "actor_stewardship_events" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"parent_actor_id" text,
	"event_type" text NOT NULL,
	"authorized_by_actor_id" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actor_stewardship_events_type_check" CHECK ("actor_stewardship_events"."event_type" IN ('accepted', 'revoked', 'reassigned'))
);
--> statement-breakpoint
ALTER TABLE "actor_stewardship_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "actor_stewardship_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "actors" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"display_name" text,
	"user_id" text,
	"legacy_user_id" text,
	"billing_account_id" text NOT NULL,
	"spawned_by_actor_id" text,
	"parent_actor_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actors_kind_check" CHECK ("actors"."kind" IN ('user', 'agent', 'system', 'org')),
	CONSTRAINT "actors_status_check" CHECK ("actors"."status" IN ('active', 'suspended')),
	CONSTRAINT "actors_user_shape_check" CHECK (("actors"."kind" = 'user' AND "actors"."user_id" IS NOT NULL) OR ("actors"."kind" <> 'user' AND "actors"."user_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "actors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "actors" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"node_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"predecessor_credential_id" text,
	"rotation_idempotency_key" text,
	"replaced_by_credential_id" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"authenticate_until" timestamp with time zone NOT NULL,
	"renew_until" timestamp with time zone NOT NULL,
	"pending_expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_credentials_secret_hash_unique" UNIQUE("secret_hash"),
	CONSTRAINT "agent_credentials_status_check" CHECK ("agent_credentials"."status" IN ('pending', 'active', 'revoked')),
	CONSTRAINT "agent_credentials_windows_check" CHECK ("agent_credentials"."renew_until" > "agent_credentials"."authenticate_until")
);
--> statement-breakpoint
ALTER TABLE "agent_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_recovery_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"node_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"issuer_actor_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_credential_id" text,
	"redeemed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_recovery_grants_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "agent_recovery_grants_status_check" CHECK ("agent_recovery_grants"."status" IN ('pending', 'redeemed', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "agent_recovery_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_recovery_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_spawn_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"node_id" text NOT NULL,
	"issuer_actor_id" text NOT NULL,
	"accepted_parent_actor_id" text,
	"billing_account_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_actor_id" text,
	"redeemed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_spawn_grants_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "agent_spawn_grants_status_check" CHECK ("agent_spawn_grants"."status" IN ('pending', 'redeemed', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "agent_spawn_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_spawn_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "actor_stewardship_events" ADD CONSTRAINT "actor_stewardship_events_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_stewardship_events" ADD CONSTRAINT "actor_stewardship_events_parent_actor_id_actors_id_fk" FOREIGN KEY ("parent_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_stewardship_events" ADD CONSTRAINT "actor_stewardship_events_authorized_by_actor_id_actors_id_fk" FOREIGN KEY ("authorized_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_legacy_user_id_users_id_fk" FOREIGN KEY ("legacy_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_spawned_by_actor_id_actors_id_fk" FOREIGN KEY ("spawned_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_parent_actor_id_actors_id_fk" FOREIGN KEY ("parent_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_predecessor_credential_id_agent_credentials_id_fk" FOREIGN KEY ("predecessor_credential_id") REFERENCES "public"."agent_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_replaced_by_credential_id_agent_credentials_id_fk" FOREIGN KEY ("replaced_by_credential_id") REFERENCES "public"."agent_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_recovery_grants" ADD CONSTRAINT "agent_recovery_grants_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_recovery_grants" ADD CONSTRAINT "agent_recovery_grants_issuer_actor_id_actors_id_fk" FOREIGN KEY ("issuer_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_recovery_grants" ADD CONSTRAINT "agent_recovery_grants_redeemed_credential_id_agent_credentials_id_fk" FOREIGN KEY ("redeemed_credential_id") REFERENCES "public"."agent_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_spawn_grants" ADD CONSTRAINT "agent_spawn_grants_issuer_actor_id_actors_id_fk" FOREIGN KEY ("issuer_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_spawn_grants" ADD CONSTRAINT "agent_spawn_grants_accepted_parent_actor_id_actors_id_fk" FOREIGN KEY ("accepted_parent_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_spawn_grants" ADD CONSTRAINT "agent_spawn_grants_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_spawn_grants" ADD CONSTRAINT "agent_spawn_grants_redeemed_actor_id_actors_id_fk" FOREIGN KEY ("redeemed_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "actor_stewardship_events_actor_id_idx" ON "actor_stewardship_events" USING btree ("actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "actors_user_id_unique" ON "actors" USING btree ("user_id") WHERE "actors"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "actors_legacy_user_id_unique" ON "actors" USING btree ("legacy_user_id") WHERE "actors"."legacy_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "actors_billing_account_id_idx" ON "actors" USING btree ("billing_account_id");--> statement-breakpoint
CREATE INDEX "actors_parent_actor_id_idx" ON "actors" USING btree ("parent_actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_pending_predecessor_unique" ON "agent_credentials" USING btree ("predecessor_credential_id") WHERE "agent_credentials"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "agent_credentials_actor_status_idx" ON "agent_credentials" USING btree ("actor_id","status");--> statement-breakpoint
CREATE INDEX "agent_credentials_node_status_idx" ON "agent_credentials" USING btree ("node_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_recovery_grants_issuer_idempotency_unique" ON "agent_recovery_grants" USING btree ("issuer_actor_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "agent_recovery_grants_actor_status_idx" ON "agent_recovery_grants" USING btree ("actor_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_spawn_grants_issuer_idempotency_unique" ON "agent_spawn_grants" USING btree ("issuer_actor_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "agent_spawn_grants_issuer_status_idx" ON "agent_spawn_grants" USING btree ("issuer_actor_id","status");--> statement-breakpoint
CREATE INDEX "agent_spawn_grants_billing_status_idx" ON "agent_spawn_grants" USING btree ("billing_account_id","status");
--> statement-breakpoint
CREATE TRIGGER actor_stewardship_events_append_only
  BEFORE UPDATE OR DELETE ON "actor_stewardship_events"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
