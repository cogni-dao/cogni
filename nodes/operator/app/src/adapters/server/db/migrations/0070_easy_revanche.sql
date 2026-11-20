CREATE TABLE "knowledge_cite_pairs" (
	"atom_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"first_item_revision" integer NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_cite_pairs_atom_id_work_item_id_pk" PRIMARY KEY("atom_id","work_item_id")
);
--> statement-breakpoint
ALTER TABLE "knowledge_cite_pairs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge_read_daily" (
	"day" date NOT NULL,
	"atom_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"principal_class" text NOT NULL,
	"ok_count" integer DEFAULT 0 NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_read_daily_day_atom_id_principal_id_principal_class_pk" PRIMARY KEY("day","atom_id","principal_id","principal_class"),
	CONSTRAINT "knowledge_read_daily_principal_class_check" CHECK ("knowledge_read_daily"."principal_class" IN ('internal_run', 'external_agent'))
);
--> statement-breakpoint
ALTER TABLE "knowledge_read_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_cite_pairs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_read_daily" FORCE ROW LEVEL SECURITY;
