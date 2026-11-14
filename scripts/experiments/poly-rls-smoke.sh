#!/usr/bin/env bash
# poly-rls-smoke.sh — manual smoke test for poly_copy_trade_targets RLS policy.
#
# Reproduces task.0318 Phase A acceptance check #2 from
# https://poly.cognidao.org/knowledge/poly-tenant-wallet-authorization:
#
#   "psql smoke as app_user: SET LOCAL app.current_user_id = '<userA-uuid>';
#    INSERT INTO poly_copy_trade_targets (..., created_by_user_id) VALUES
#    (..., '<userB-uuid>'); is rejected by WITH CHECK."
#
# Usage:
#   POLY_PSQL='psql postgresql://app_user:...@localhost:5432/cogni_poly' \
#     scripts/experiments/poly-rls-smoke.sh
#
# Requires: an app_user role with FORCE RLS enabled (provision.sh default),
# at least two seeded users with billing accounts, plus the migration 0029
# tables in place. Cleans up its own test rows on success.
#
# Exit codes:
#   0  RLS rejected the cross-tenant insert as expected.
#   1  Insert succeeded — RLS policy regression. Investigate immediately.
#   2  Setup failure (no psql, missing seed rows, etc.).

set -euo pipefail

if [[ -z "${POLY_PSQL:-}" ]]; then
  echo "ERROR: set POLY_PSQL to a psql command pointing at the poly DB as app_user." >&2
  echo "       e.g. POLY_PSQL='psql postgresql://app_user:...@localhost:5432/cogni_poly'" >&2
  exit 2
fi

# Pick two distinct seeded users with billing accounts.
read -r USER_A USER_B BA_A BA_B <<<"$($POLY_PSQL -tAX -F' ' <<'SQL'
SELECT
  ua.id, ub.id, baa.id, bab.id
FROM users ua
JOIN billing_accounts baa ON baa.owner_user_id = ua.id
CROSS JOIN LATERAL (
  SELECT u.id FROM users u
  JOIN billing_accounts ba ON ba.owner_user_id = u.id
  WHERE u.id <> ua.id
  LIMIT 1
) ub
JOIN billing_accounts bab ON bab.owner_user_id = ub.id
LIMIT 1;
SQL
)"

if [[ -z "${USER_A:-}" || -z "${USER_B:-}" ]]; then
  echo "ERROR: need at least two seeded users with billing_accounts. Seed first." >&2
  exit 2
fi

WALLET="0x$(openssl rand -hex 20)"

echo "Smoke test:"
echo "  user A:           $USER_A"
echo "  user B:           $USER_B"
echo "  billing acct A:   $BA_A"
echo "  billing acct B:   $BA_B"
echo "  test wallet:      $WALLET"
echo

echo "[1/2] Cross-tenant insert (should be REJECTED by RLS WITH CHECK)..."
set +e
$POLY_PSQL -v ON_ERROR_STOP=1 <<SQL 2>&1
BEGIN;
SET LOCAL app.current_user_id = '$USER_A';
INSERT INTO poly_copy_trade_targets
  (billing_account_id, created_by_user_id, target_wallet)
VALUES
  ('$BA_B', '$USER_B', '$WALLET');
ROLLBACK;
SQL
RC=$?
set -e

if [[ $RC -eq 0 ]]; then
  echo "FAIL: cross-tenant INSERT succeeded — RLS policy regression." >&2
  exit 1
fi
echo "OK: cross-tenant INSERT rejected (rc=$RC, expected nonzero)."
echo

echo "[2/2] Same-tenant insert (should SUCCEED) — exercise the happy path..."
$POLY_PSQL -v ON_ERROR_STOP=1 <<SQL >/dev/null
BEGIN;
SET LOCAL app.current_user_id = '$USER_A';
INSERT INTO poly_copy_trade_targets
  (billing_account_id, created_by_user_id, target_wallet)
VALUES
  ('$BA_A', '$USER_A', '$WALLET');
DELETE FROM poly_copy_trade_targets
  WHERE billing_account_id = '$BA_A'
    AND target_wallet = '$WALLET';
COMMIT;
SQL
echo "OK: same-tenant INSERT + cleanup succeeded."
echo
echo "RLS smoke PASSED."
