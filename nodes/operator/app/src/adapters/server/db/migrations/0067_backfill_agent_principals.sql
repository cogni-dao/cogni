-- Backfill (story.5167): every outside agent registered before registration wrote its principal row gets an external `agent_principals` row,
-- so kind is read from one place (`@cogni-dao/agent-grants` 0.8.0 key upgrade refuses a user with no row). Data only, idempotent (ON CONFLICT DO NOTHING).
-- PRECISION OVER COVERAGE: a human misread as an agent could lose pay; a missed agent is only a missing label. A user is picked as an agent only
-- when every durable trace of its creation is the agent path. The v1 key is a signed token that is not stored, so the traces are the user's rows:
--   agent register   nodes/operator/app/src/app/api/v1/agent/register/route.ts: users row, wallet NULL, no profile, no binding, no event.
--   agent GitHub link  auth.ts:430 `createBinding(..., { method: "oauth_link" })` -> create-binding.ts:45-67: a `user_bindings` row (provider github) + an
--                    `identity_events` row (event_type "bind", payload.method "oauth_link"). No `user_profiles` row.
-- Human paths, each of which this rule excludes:
--   SIWE sign-in     auth.ts:225 users row with wallet_address; auth.ts:237 user_profiles row; auth.ts:257 binding (provider wallet) + event payload.method "siwe".
--   OAuth first sign-in  auth.ts:459-495 one transaction: users row (wallet NULL), user_bindings row (github, discord or google), identity_events
--                    (event_type "bind", payload.method "oauth", auth.ts:484-488), user_profiles row (auth.ts:494). A GitHub first-sign-in human is told apart
--                    from a GitHub-linked agent by the profile row and by payload.method "oauth" (a link writes neither).
-- Rule: wallet IS NULL; not the seeded system tenant (0008); no user_profiles row; every user_bindings row is provider github; every identity_events
-- row has payload.method "oauth_link". A user that already has a principal row (internal or external) keeps it.
-- users, user_bindings, user_profiles and identity_events have FORCE RLS keyed to a session user, and agent_principals is select-only for every
-- role, so a migration run as the table owner would see no rows (every NOT EXISTS would then be true). Lift FORCE for this statement only,
-- inside the migration transaction (same as 0037 and 0040), and restore it after.
ALTER TABLE "users" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_bindings" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_profiles" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "identity_events" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_principals" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "agent_principals" ("kind", "user_id")
SELECT 'external', u."id"
FROM "users" u
WHERE u."wallet_address" IS NULL
  AND u."id" <> '00000000-0000-4000-a000-000000000001'
  AND NOT EXISTS (SELECT 1 FROM "user_profiles" p WHERE p."user_id" = u."id")
  AND NOT EXISTS (SELECT 1 FROM "user_bindings" b WHERE b."user_id" = u."id" AND b."provider" <> 'github')
  AND NOT EXISTS (SELECT 1 FROM "identity_events" e WHERE e."user_id" = u."id" AND e."payload" ->> 'method' IS DISTINCT FROM 'oauth_link')
ON CONFLICT ("user_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "agent_principals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "identity_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_bindings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
