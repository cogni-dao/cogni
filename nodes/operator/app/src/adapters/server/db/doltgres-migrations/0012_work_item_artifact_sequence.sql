ALTER TABLE "work_item_artifacts" ADD COLUMN "seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "work_item_artifacts" ADD COLUMN "item_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "work_item_artifacts" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "work_item_artifacts" ADD COLUMN "body" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_item_artifacts_item_seq" ON "work_item_artifacts" USING btree ("item_id","seq");