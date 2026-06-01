CREATE TABLE "llm_charge_details" (
	"charge_receipt_id" uuid PRIMARY KEY NOT NULL,
	"provider_call_id" text,
	"model" text NOT NULL,
	"provider" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"latency_ms" integer,
	"graph_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_charge_details" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "llm_charge_details" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Hand-edit: backfill existing rows before enforcing NOT NULL
ALTER TABLE "charge_receipts" ADD COLUMN "receipt_kind" text NOT NULL DEFAULT 'llm';
--> statement-breakpoint
ALTER TABLE "charge_receipts" ALTER COLUMN "receipt_kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "llm_charge_details" ADD CONSTRAINT "llm_charge_details_charge_receipt_id_charge_receipts_id_fk" FOREIGN KEY ("charge_receipt_id") REFERENCES "public"."charge_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "llm_charge_details" AS PERMISSIVE FOR ALL TO public USING (EXISTS (
        SELECT 1 FROM charge_receipts cr
        JOIN billing_accounts ba ON ba.id = cr.billing_account_id
        WHERE cr.id = "llm_charge_details"."charge_receipt_id"
          AND ba.owner_user_id = current_setting('app.current_user_id', true)
      ));