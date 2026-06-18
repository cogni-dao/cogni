-- Migration: seed `operator` + `node-template` as first-class node-registry rows (story.5009).
--
-- One-off data seed (NOT a durable endpoint). These two repos are not wizard-spawned, so they
-- never enter the `nodes` table via `POST /api/v1/nodes` (the wizard reserves their slugs). This
-- anchors them as registry rows so the governance approver owns them and can grant RBAC agents.
--
-- OPERATOR_NODE_ROW_ID_IS_NODE_ID: each row's `id` IS the repo-spec / catalog `node_id`
--   (operator = .cogni/repo-spec.yaml; node-template = infra/catalog/node-template.yaml), so the
--   OpenFGA `node:<id>` resource and Loki `node` label line up with deployment identity.
-- OWNER_IS_GOVERNANCE_APPROVER: owner resolves to the user holding the approver wallet
--   0x070075F1389Ae1182aBac722B36CA12285d0c949 (.cogni/repo-spec.yaml activity_ledger.approvers),
--   which is the same human identity across candidate-a / preview / production.
-- Self-healing + idempotent: drops any prior non-canonical rows for these reserved slugs (e.g.
--   ad-hoc test rows on candidate-a) — FK to node_access_requests is ON DELETE CASCADE — then
--   re-seeds the canonical, node_id-pinned rows. No-op on an env where the approver wallet has no
--   user row yet (INSERT ... SELECT yields zero rows).

DELETE FROM "nodes" WHERE "slug" IN ('operator', 'node-template');--> statement-breakpoint

INSERT INTO "nodes" ("id", "slug", "repo_url", "repo_owner", "repo_name", "repo_visibility", "owner_user_id", "status")
SELECT
  '4ff8eac1-4eba-4ed0-931b-b1fe4f64713d',
  'operator',
  'https://github.com/cogni-dao/cogni',
  'cogni-dao',
  'cogni',
  'public',
  u."id",
  'active'
FROM "users" u
WHERE lower(u."wallet_address") = lower('0x070075F1389Ae1182aBac722B36CA12285d0c949');--> statement-breakpoint

INSERT INTO "nodes" ("id", "slug", "repo_url", "repo_owner", "repo_name", "repo_visibility", "owner_user_id", "status")
SELECT
  'b927a9dd-6132-4fc9-a51e-e3cee2568e3c',
  'node-template',
  'https://github.com/cogni-dao/node-template',
  'cogni-dao',
  'node-template',
  'public',
  u."id",
  'active'
FROM "users" u
WHERE lower(u."wallet_address") = lower('0x070075F1389Ae1182aBac722B36CA12285d0c949');
