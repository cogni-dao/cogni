-- Backfill (story.5167, mirrors node-template 0044 task.0144): every outside agent registered before registration wrote its principal row gets an external `agent_principals` row,
-- so kind is read from one place. Data only, idempotent (ON CONFLICT DO NOTHING; a rerun inserts nothing).
-- PRECISION OVER COVERAGE: an agent row stops payouts to that user's wallet (0043, AGENT_WALLET_IS_NOT_A_PAYEE), so a human misread as an agent
-- loses pay. A missed agent is only a missing label, so the rule is deliberately narrow: it picks a user only when NO trace of a human path exists.
-- The v1 key is a signed token that is not stored, so the only durable trace of an agent registration is the user it created: no wallet, no
-- binding, no profile, no identity event. Every human creation path (SIWE: auth.ts:231; OAuth first login: auth.ts:548; operator-attested
-- GitHub sign-in: operator-attested-binding.server.ts:131) sets users.wallet_address or writes a `user_bindings` row with the user (SIWE also
-- writes one), and also writes a `user_profiles` row; the two non-SIWE paths write an `identity_events` row too. The seeded system tenant is
-- excluded by id; the internal principals (0037) already have rows. A user that already has a row (internal or external) keeps it.
-- users, user_bindings, user_profiles and identity_events have FORCE RLS keyed to a session user, and agent_principals is select-only for every
-- role, so a migration run as the table owner would see no rows (every NOT EXISTS would then be true). Lift FORCE for this statement only,
-- inside the migration transaction (same as 0037 and 0038), and restore it after.
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
  AND NOT EXISTS (SELECT 1 FROM "user_bindings" b WHERE b."user_id" = u."id")
  AND NOT EXISTS (SELECT 1 FROM "user_profiles" p WHERE p."user_id" = u."id")
  AND NOT EXISTS (SELECT 1 FROM "identity_events" e WHERE e."user_id" = u."id")
ON CONFLICT ("user_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "agent_principals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "identity_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_bindings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;

