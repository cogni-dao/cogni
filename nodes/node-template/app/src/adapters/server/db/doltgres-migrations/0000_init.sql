CREATE TABLE "citations" (
	"id" text PRIMARY KEY NOT NULL,
	"citing_id" text NOT NULL,
	"cited_id" text NOT NULL,
	"citation_type" text NOT NULL,
	"context" text,
	"confidence_pct" integer DEFAULT 40 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"confidence_pct" integer DEFAULT 40 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge" (
	"id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"entity_id" text,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"entry_type" text DEFAULT 'finding' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"confidence_pct" integer DEFAULT 40 NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" text,
	"source_node" text,
	"tags" jsonb,
	"evaluate_at" timestamp with time zone,
	"resolution_strategy" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_contribution_commits" (
	"contribution_id" text NOT NULL,
	"seq" integer NOT NULL,
	"commit_hash" text NOT NULL,
	"principal_id" text NOT NULL,
	"principal_kind" text NOT NULL,
	"auth_source" text NOT NULL,
	"message" text NOT NULL,
	"edit_count" integer NOT NULL,
	"source_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_kcc_contribution_seq" PRIMARY KEY("contribution_id","seq")
);
--> statement-breakpoint
CREATE TABLE "knowledge_contributions" (
	"id" text PRIMARY KEY NOT NULL,
	"branch" text NOT NULL,
	"state" text NOT NULL,
	"principal_id" text NOT NULL,
	"principal_kind" text NOT NULL,
	"message" text NOT NULL,
	"base_commit" text NOT NULL,
	"head_commit" text,
	"commit_count" integer DEFAULT 0 NOT NULL,
	"merged_commit" text,
	"closed_reason" text,
	"idempotency_key" text,
	"confidence_pct" integer DEFAULT 40 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text,
	"name" text NOT NULL,
	"source_type" text NOT NULL,
	"confidence_pct" integer DEFAULT 40 NOT NULL,
	"last_accessed" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"node" text DEFAULT 'shared' NOT NULL,
	"project_id" text,
	"parent_id" text,
	"priority" integer,
	"rank" integer,
	"estimate" integer,
	"summary" text,
	"outcome" text,
	"branch" text,
	"pr" text,
	"reviewer" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"blocked_by" text,
	"deploy_verified" boolean DEFAULT false NOT NULL,
	"claimed_by_run" text,
	"claimed_at" timestamp with time zone,
	"last_command" text,
	"assignees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"external_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"spec_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_citations_citing" ON "citations" USING btree ("citing_id");--> statement-breakpoint
CREATE INDEX "idx_citations_cited" ON "citations" USING btree ("cited_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_citations_edge" ON "citations" USING btree ("citing_id","cited_id","citation_type");--> statement-breakpoint
CREATE INDEX "idx_knowledge_domain" ON "knowledge" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "idx_knowledge_entity" ON "knowledge" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_knowledge_source_type" ON "knowledge" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "idx_knowledge_status" ON "knowledge" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_knowledge_source_node" ON "knowledge" USING btree ("source_node");--> statement-breakpoint
CREATE INDEX "idx_knowledge_resolver_due" ON "knowledge" USING btree ("evaluate_at","resolution_strategy");--> statement-breakpoint
CREATE INDEX "idx_kcc_commit_hash" ON "knowledge_contribution_commits" USING btree ("commit_hash");--> statement-breakpoint
CREATE INDEX "idx_kc_state" ON "knowledge_contributions" USING btree ("state");--> statement-breakpoint
CREATE INDEX "idx_kc_principal" ON "knowledge_contributions" USING btree ("principal_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kc_idempotency" ON "knowledge_contributions" USING btree ("principal_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_work_items_type" ON "work_items" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_work_items_status" ON "work_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_work_items_node" ON "work_items" USING btree ("node");--> statement-breakpoint
CREATE INDEX "idx_work_items_project_id" ON "work_items" USING btree ("project_id");