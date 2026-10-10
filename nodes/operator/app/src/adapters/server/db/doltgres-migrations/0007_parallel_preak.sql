ALTER TABLE "work_items" ADD COLUMN "claim_owner_principal_id" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "created_by_principal_id" text;