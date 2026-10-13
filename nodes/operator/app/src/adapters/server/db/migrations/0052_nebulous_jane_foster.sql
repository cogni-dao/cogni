ALTER TABLE "execution_requests" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_requests" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "execution_requests" SET "lease_expires_at" = now() WHERE "ok" IS NULL;
