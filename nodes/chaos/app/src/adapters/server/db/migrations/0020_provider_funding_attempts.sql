CREATE TABLE IF NOT EXISTS "provider_funding_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_intent_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider" text DEFAULT 'openrouter' NOT NULL,
	"charge_id" text,
	"charge_expires_at" timestamp with time zone,
	"amount_usdc_micro" bigint,
	"funding_tx_hash" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_funding_attempts_payment_intent_id_unique" UNIQUE("payment_intent_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_funding_attempts_status_idx" ON "provider_funding_attempts" USING btree ("status","created_at");
--> statement-breakpoint
ALTER TABLE "provider_funding_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "provider_funding_attempts" FORCE ROW LEVEL SECURITY;
