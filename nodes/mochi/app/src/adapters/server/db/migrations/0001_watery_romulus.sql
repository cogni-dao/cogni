CREATE TABLE "execution_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"billing_account_id" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"langfuse_trace_id" text,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"execution_grant_id" uuid NOT NULL,
	"graph_id" text NOT NULL,
	"input" jsonb NOT NULL,
	"cron" text NOT NULL,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_grants" ADD CONSTRAINT "execution_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_grants" ADD CONSTRAINT "execution_grants_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_execution_grant_id_execution_grants_id_fk" FOREIGN KEY ("execution_grant_id") REFERENCES "public"."execution_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_grants_user_idx" ON "execution_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "execution_grants_billing_account_idx" ON "execution_grants" USING btree ("billing_account_id");--> statement-breakpoint
CREATE INDEX "schedule_runs_schedule_idx" ON "schedule_runs" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "schedule_runs_scheduled_for_idx" ON "schedule_runs" USING btree ("scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_runs_schedule_slot_unique" ON "schedule_runs" USING btree ("schedule_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "schedule_runs_run_id_idx" ON "schedule_runs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "schedules_owner_idx" ON "schedules" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "schedules_next_run_idx" ON "schedules" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "schedules_grant_idx" ON "schedules" USING btree ("execution_grant_id");