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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_contributions" (
	"id" text PRIMARY KEY NOT NULL,
	"branch" text NOT NULL,
	"state" text NOT NULL,
	"principal_id" text NOT NULL,
	"principal_kind" text NOT NULL,
	"message" text NOT NULL,
	"entry_count" integer NOT NULL,
	"commit_hash" text NOT NULL,
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
CREATE INDEX "idx_citations_citing" ON "citations" USING btree ("citing_id");--> statement-breakpoint
CREATE INDEX "idx_citations_cited" ON "citations" USING btree ("cited_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_citations_edge" ON "citations" USING btree ("citing_id","cited_id","citation_type");--> statement-breakpoint
CREATE INDEX "idx_knowledge_domain" ON "knowledge" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "idx_knowledge_entity" ON "knowledge" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_knowledge_source_type" ON "knowledge" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "idx_knowledge_status" ON "knowledge" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_knowledge_source_node" ON "knowledge" USING btree ("source_node");--> statement-breakpoint
CREATE INDEX "idx_kc_state" ON "knowledge_contributions" USING btree ("state");--> statement-breakpoint
CREATE INDEX "idx_kc_principal" ON "knowledge_contributions" USING btree ("principal_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kc_idempotency" ON "knowledge_contributions" USING btree ("principal_id","idempotency_key");
