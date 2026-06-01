ALTER TABLE "billing_accounts" ADD COLUMN "is_system_tenant" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "slug" text;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_one_system_tenant" ON "billing_accounts" USING btree ("is_system_tenant") WHERE "billing_accounts"."is_system_tenant" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_revenue_share_ref_unique" ON "credit_ledger" USING btree ("reference") WHERE "credit_ledger"."reason" = 'platform_revenue_share';--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_slug_unique" UNIQUE("slug");