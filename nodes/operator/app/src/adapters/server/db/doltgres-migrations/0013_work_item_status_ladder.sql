ALTER TABLE "work_items" ADD COLUMN "status_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "work_items" SET "status_revision" = "revision";--> statement-breakpoint
UPDATE "work_items" SET "status" = 'needs_closeout' WHERE "status" = 'needs_merge';
