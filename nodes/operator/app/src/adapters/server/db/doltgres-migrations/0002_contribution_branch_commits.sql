ALTER TABLE "knowledge_contributions" ADD COLUMN IF NOT EXISTS "entry_count" integer;
--> statement-breakpoint
ALTER TABLE "knowledge_contributions" ADD COLUMN IF NOT EXISTS "commit_hash" text;
--> statement-breakpoint
ALTER TABLE "knowledge_contributions" ADD COLUMN IF NOT EXISTS "base_commit" text;
--> statement-breakpoint
ALTER TABLE "knowledge_contributions" ADD COLUMN IF NOT EXISTS "head_commit" text;
--> statement-breakpoint
ALTER TABLE "knowledge_contributions" ADD COLUMN IF NOT EXISTS "commit_count" integer DEFAULT 0;
--> statement-breakpoint
UPDATE "knowledge_contributions"
SET "base_commit" = COALESCE(NULLIF("base_commit", ''), NULLIF(NULLIF("commit_hash", ''), 'undefined'), 'main')
WHERE "base_commit" IS NULL OR "base_commit" = '' OR "base_commit" = 'undefined';
--> statement-breakpoint
UPDATE "knowledge_contributions"
SET "head_commit" = NULLIF(NULLIF("commit_hash", ''), 'undefined')
WHERE ("head_commit" IS NULL OR "head_commit" = '') AND NULLIF(NULLIF("commit_hash", ''), 'undefined') IS NOT NULL;
--> statement-breakpoint
UPDATE "knowledge_contributions"
SET "commit_count" = CASE
  WHEN NULLIF(NULLIF("commit_hash", ''), 'undefined') IS NULL THEN 0
  ELSE 1
END
WHERE "commit_count" IS NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_contributions" ALTER COLUMN "base_commit" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_contributions" ALTER COLUMN "commit_count" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "knowledge_contributions" ALTER COLUMN "commit_count" SET NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_contribution_commits" (
	"contribution_id" text NOT NULL,
	"seq" integer NOT NULL,
	"commit_hash" text NOT NULL,
	"principal_id" text NOT NULL,
	"principal_kind" text NOT NULL,
	"auth_source" text NOT NULL,
	"message" text NOT NULL,
	"edit_count" integer NOT NULL,
	"source_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_kcc_contribution_seq" PRIMARY KEY("contribution_id","seq")
);
--> statement-breakpoint
INSERT INTO "knowledge_contribution_commits" (
  "contribution_id",
  "seq",
  "commit_hash",
  "principal_id",
  "principal_kind",
  "auth_source",
  "message",
  "edit_count",
  "source_ref",
  "created_at"
)
SELECT
  "id",
  1,
  NULLIF(NULLIF("commit_hash", ''), 'undefined'),
  "principal_id",
  "principal_kind",
  'bearer',
  "message",
  COALESCE("entry_count", 1),
  'contribution:' || "id" || ':1',
  "created_at"
FROM "knowledge_contributions"
WHERE NULLIF(NULLIF("commit_hash", ''), 'undefined') IS NOT NULL
ON CONFLICT ("contribution_id", "seq") DO NOTHING;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kcc_commit_hash" ON "knowledge_contribution_commits" USING btree ("commit_hash");
--> statement-breakpoint
ALTER TABLE "knowledge_contributions" DROP COLUMN IF EXISTS "entry_count";
--> statement-breakpoint
ALTER TABLE "knowledge_contributions" DROP COLUMN IF EXISTS "commit_hash";
