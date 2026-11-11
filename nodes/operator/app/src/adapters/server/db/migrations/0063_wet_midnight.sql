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