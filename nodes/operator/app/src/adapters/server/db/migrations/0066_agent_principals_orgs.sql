-- Orgs (`@cogni-dao/agent-grants` 0.8.0, story.5167): mirrors the package's `migrations/agent_principals_orgs.sql`
-- (drizzle-kit output, identical statements) made idempotent. Strictly additive: two nullable columns, one partial
-- unique index, one CHECK that only constrains `org` rows, and the kind CHECK widened to admit `org`. Existing rows are
-- untouched (both new columns are null; no operator row has kind `org`), so the re-added CHECKs hold on every row.
ALTER TABLE "agent_principals" DROP CONSTRAINT IF EXISTS "agent_principals_kind_canonical";--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN IF NOT EXISTS "owner_source_kind" text;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN IF NOT EXISTS "owner_source_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_principals_org_source_unique" ON "agent_principals" USING btree ("owner_source_kind","owner_source_ref") WHERE "agent_principals"."kind" = 'org';--> statement-breakpoint
ALTER TABLE "agent_principals" DROP CONSTRAINT IF EXISTS "agent_principals_org_has_owner_source";--> statement-breakpoint
ALTER TABLE "agent_principals" ADD CONSTRAINT "agent_principals_org_has_owner_source" CHECK ("agent_principals"."kind" <> 'org' OR ("agent_principals"."owner_source_kind" IS NOT NULL AND "agent_principals"."owner_source_ref" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "agent_principals" ADD CONSTRAINT "agent_principals_kind_canonical" CHECK ("agent_principals"."kind" IN ('internal','external','org'));
