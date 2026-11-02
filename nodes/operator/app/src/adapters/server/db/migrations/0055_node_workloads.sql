CREATE TABLE "node_workload_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"cogni_key" text NOT NULL,
	"external_name" text,
	"provider" text,
	"endpoints" jsonb NOT NULL,
	"phase" text NOT NULL,
	"error" text,
	"unhealthy_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_workload_attempts_cogni_key_uniq" UNIQUE("cogni_key"),
	CONSTRAINT "node_workload_attempts_release_attempt_uniq" UNIQUE("release_id","attempt")
);
--> statement-breakpoint
CREATE TABLE "node_workload_desired" (
	"node_id" uuid NOT NULL,
	"env" text NOT NULL,
	"workload" text NOT NULL,
	"state" text NOT NULL,
	"release_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_workload_desired_pkey" PRIMARY KEY("node_id","env","workload")
);
--> statement-breakpoint
CREATE TABLE "node_workload_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"env" text NOT NULL,
	"workload" text NOT NULL,
	"source_sha" text NOT NULL,
	"spec" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node_workload_attempts" ADD CONSTRAINT "node_workload_attempts_release_id_node_workload_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."node_workload_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_workload_desired" ADD CONSTRAINT "node_workload_desired_release_id_node_workload_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."node_workload_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_workload_attempts_phase_idx" ON "node_workload_attempts" USING btree ("phase");--> statement-breakpoint
CREATE INDEX "node_workload_releases_workload_idx" ON "node_workload_releases" USING btree ("node_id","env","workload","created_at");