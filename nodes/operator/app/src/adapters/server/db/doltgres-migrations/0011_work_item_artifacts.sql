CREATE TABLE "work_item_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"verdict" text NOT NULL,
	"rows" jsonb,
	"url" text,
	"author" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_work_item_artifacts_item_created" ON "work_item_artifacts" USING btree ("item_id","created_at");