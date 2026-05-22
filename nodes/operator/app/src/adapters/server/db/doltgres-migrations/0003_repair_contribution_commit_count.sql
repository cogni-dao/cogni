UPDATE "knowledge_contributions" AS "kc"
SET "commit_count" = "sub"."cnt"
FROM (
  SELECT "contribution_id", MAX("seq") AS "cnt"
  FROM "knowledge_contribution_commits"
  GROUP BY "contribution_id"
) AS "sub"
WHERE "kc"."id" = "sub"."contribution_id"
  AND "kc"."commit_count" < "sub"."cnt";
