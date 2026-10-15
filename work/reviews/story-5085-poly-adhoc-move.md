# Poly prod DB move: ad-hoc, documented runbook (reviewer proposal, 2026-10-15)

## Why

Poly prod has been fenced (`/readyz` 503) since 2026-10-13. The current task.5246 path is fully code-driven: a typed state-cell provisioner (#2730), a materializer-driven DSN rotation, an 8-file same-writer rollback phase (uncommitted), and three cells (candidate, preview, prod) gated behind a candidate 20GB replay. That replay is itself gated on the #2729 flight, which needs its KITS_JSON projection. None of it has touched the prod DB. A one-time move is an operation, not a product feature. Run it by hand, record every step, and automate later.

## Steps (one owner, CEO-authorized, every command + output logged to task.5246)

1. **Cell.** Provision one Akash Postgres 15 lease for Poly prod using the spike.5006 recipe: persistent volume, TLS, and an off-host backup target. Record lease/provider/DNS.
2. **Fence holds.** Poly is already fenced, so there are no writers and no dual-write risk. Confirm zero Poly sessions on shared prod PG.
3. **Copy.** Run `pg_dump -Fc` on the Poly prod DB from shared prod PG, then `pg_restore` it into the cell. Verify per-table row counts plus checksums on the key tables.
4. **Point.** Write the Poly prod app/service/migration DSNs into OpenBao (the existing writer path). ESO syncs, then restart Poly.
5. **Stop the overwrite.** The materializer recomposes shared DSNs on every deploy (task.5246 finding), so a routine Poly deploy would silently point Poly back at shared PG. Until a durable placement binding ships, freeze Poly prod promotes, or land a one-line catalog override the materializer honors. This is the only code on the critical path.
6. **Prove + readmit.** Get two-region `/readyz` 200 at the exact SHA, run a DB-backed behavior check, then the CEO clicks readmit.
7. **Rollback.** Keep the source DB untouched and read-only. Reversal is: restore the old DSNs in OpenBao, then restart. Drop the source only after 7 days of stability.

## Same pattern: clean prod PG of non-prod tenants (bug.5299)

Move `cogni_poly_candidate_a` and `cogni_red_candidate_a` (plus any other non-prod DB on the prod host) by hand to their own env's Postgres, using the same dump/restore/DSN steps and a log. Then drop them from prod. The merged #2724 CI guard keeps it clean.

## Not on the critical path

#2729 (auto-containment controller), the candidate 20GB replay, and the typed cell automation. They protect the _next_ noisy tenant and close story.5085, but they do not gate Poly's return (architect plan, Lane 1 vs Lane 2).
