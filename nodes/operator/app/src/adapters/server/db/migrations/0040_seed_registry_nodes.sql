-- Migration: seed the tier-1 node-registry rows env-agnostically (owner resolved by wallet).
--
-- WHY THIS EXISTS: a fresh env reprovision brings up an EMPTY operator `nodes` registry (node rows are
--   app-written runtime state, not migration state). With no rows, the owner wallet owns zero nodes under
--   the `tenant_isolation` RLS policy, and every operator-control-plane resolve (secrets / flight / logs /
--   access-requests) 404s `node_not_found` for the reserved node. 0037 was meant to anchor the two reserved
--   slugs, but it NO-OPS on a fresh DB: it resolves owner by wallet yet never inserts the `users` row, and
--   migrations run before anyone SIWE-logs in. This migration is the reproducible, SSH-free fix — it runs in
--   the operator `migrate` initContainer on the next deploy and seeds candidate-a + preview + production, and
--   self-heals on every future reprovision (a fresh DB replays all migrations). Break-glass hand-seed retired.
--   Design: docs/design/node-wizard-formation-wiring.md § Owner binding (tactical). Principle:
--   docs/spec/identity-model.md BINDING_IS_THE_MULTI_ENV_KEY. Postmortem:
--   pm.prod-reprovision-nodes-registry-reseed.2026-08-05.
--
-- BINDING_IS_THE_MULTI_ENV_KEY: `users.id` is an env-local surrogate (SIWE mints a fresh UUID per env on
--   first login). `wallet_address` is the stable, env-independent binding. Ownership therefore resolves
--   THROUGH the wallet, never a hardcoded per-env `user_id` — so this one migration is correct on all three
--   envs at once, and SIWE reuses the seeded row on the owner's next login (`session.id == owner_user_id`).
--
-- OPERATOR_NODE_ROW_ID_IS_NODE_ID: each row's `id` IS the repo-spec / catalog `node_id` (REPO_SPEC_IS_IDENTITY_SSOT),
--   so the OpenFGA `node:<id>` resource and the Loki `node` label line up with deployment identity.
--
-- Non-destructive vs 0037: `ON CONFLICT (slug) DO UPDATE` (owner + status), NOT 0037's DELETE+INSERT — no
--   cascade into `node_access_requests`, idempotent, re-run friendly. (It cannot rewrite the PK of a
--   pre-existing mis-id'd row; none exist — 0037 already inserted operator's id on every applied env, so a
--   PK collision on 4ff8eac1… would have failed 0037 first. standalone-node / cogni-poly reuse that id and
--   are deliberately EXCLUDED here.)
--
-- RLS: `nodes` + `users` are ENABLE + FORCE row-level security (database-rls.md). The migrator role OWNS both
--   tables but is NOT BYPASSRLS, so plain DML no-ops under the tenant policies (no `app.current_user_id`
--   context). This is a cross-tenant seed — lift RLS for the seed, then restore ENABLE + FORCE. Drizzle runs
--   each migration in a transaction, so a failure rolls back the lift (the only statement that can fail is the
--   first ALTER, before anything is disabled) — RLS can never be left off.

ALTER TABLE "users" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "nodes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- The bit 0037 omits — ensure the owner exists even on an env where the wallet has never logged in.
INSERT INTO "users" ("id", "wallet_address")
VALUES (gen_random_uuid(), '0x070075F1389Ae1182aBac722B36CA12285d0c949')
ON CONFLICT ("wallet_address") DO NOTHING;--> statement-breakpoint

INSERT INTO "nodes" ("id", "slug", "repo_url", "repo_owner", "repo_name", "repo_visibility", "owner_user_id", "status")
SELECT '4ff8eac1-4eba-4ed0-931b-b1fe4f64713d', 'operator', 'https://github.com/cogni-dao/cogni', 'cogni-dao', 'cogni', 'public', u."id", 'active'
FROM "users" u WHERE lower(u."wallet_address") = lower('0x070075F1389Ae1182aBac722B36CA12285d0c949')
ON CONFLICT ("slug") DO UPDATE SET "owner_user_id" = EXCLUDED."owner_user_id", "status" = 'active';--> statement-breakpoint

INSERT INTO "nodes" ("id", "slug", "repo_url", "repo_owner", "repo_name", "repo_visibility", "owner_user_id", "status")
SELECT 'b927a9dd-6132-4fc9-a51e-e3cee2568e3c', 'node-template', 'https://github.com/cogni-dao/node-template', 'cogni-dao', 'node-template', 'public', u."id", 'active'
FROM "users" u WHERE lower(u."wallet_address") = lower('0x070075F1389Ae1182aBac722B36CA12285d0c949')
ON CONFLICT ("slug") DO UPDATE SET "owner_user_id" = EXCLUDED."owner_user_id", "status" = 'active';--> statement-breakpoint

INSERT INTO "nodes" ("id", "slug", "repo_url", "repo_owner", "repo_name", "repo_visibility", "owner_user_id", "status")
SELECT 'f97f68f2-8406-4a3b-b5a9-d579b779f19d', 'beacon', 'https://github.com/cogni-dao/beacon', 'cogni-dao', 'beacon', 'public', u."id", 'active'
FROM "users" u WHERE lower(u."wallet_address") = lower('0x070075F1389Ae1182aBac722B36CA12285d0c949')
ON CONFLICT ("slug") DO UPDATE SET "owner_user_id" = EXCLUDED."owner_user_id", "status" = 'active';--> statement-breakpoint

INSERT INTO "nodes" ("id", "slug", "repo_url", "repo_owner", "repo_name", "repo_visibility", "owner_user_id", "status")
SELECT '4b06359a-a859-4399-888e-a8c7a6696f7e', 'poly', 'https://github.com/cogni-dao/poly', 'cogni-dao', 'poly', 'public', u."id", 'active'
FROM "users" u WHERE lower(u."wallet_address") = lower('0x070075F1389Ae1182aBac722B36CA12285d0c949')
ON CONFLICT ("slug") DO UPDATE SET "owner_user_id" = EXCLUDED."owner_user_id", "status" = 'active';--> statement-breakpoint

INSERT INTO "nodes" ("id", "slug", "repo_url", "repo_owner", "repo_name", "repo_visibility", "owner_user_id", "status")
SELECT 'da3777a6-1f33-463a-a73c-70924806da50', 'blue', 'https://github.com/cogni-dao/blue', 'cogni-dao', 'blue', 'public', u."id", 'active'
FROM "users" u WHERE lower(u."wallet_address") = lower('0x070075F1389Ae1182aBac722B36CA12285d0c949')
ON CONFLICT ("slug") DO UPDATE SET "owner_user_id" = EXCLUDED."owner_user_id", "status" = 'active';--> statement-breakpoint

INSERT INTO "nodes" ("id", "slug", "repo_url", "repo_owner", "repo_name", "repo_visibility", "owner_user_id", "status")
SELECT '4d7ffb44-fc26-4a55-864f-eff9fbc8aba1', 'oss', 'https://github.com/cogni-dao/oss', 'cogni-dao', 'oss', 'public', u."id", 'active'
FROM "users" u WHERE lower(u."wallet_address") = lower('0x070075F1389Ae1182aBac722B36CA12285d0c949')
ON CONFLICT ("slug") DO UPDATE SET "owner_user_id" = EXCLUDED."owner_user_id", "status" = 'active';--> statement-breakpoint

INSERT INTO "nodes" ("id", "slug", "repo_url", "repo_owner", "repo_name", "repo_visibility", "owner_user_id", "status")
SELECT 'dbf1eeb7-85d4-4fd5-a4fe-da85c668bb03', 'habitat', 'https://github.com/cogni-dao/habitat', 'cogni-dao', 'habitat', 'public', u."id", 'active'
FROM "users" u WHERE lower(u."wallet_address") = lower('0x070075F1389Ae1182aBac722B36CA12285d0c949')
ON CONFLICT ("slug") DO UPDATE SET "owner_user_id" = EXCLUDED."owner_user_id", "status" = 'active';--> statement-breakpoint

ALTER TABLE "nodes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "nodes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
