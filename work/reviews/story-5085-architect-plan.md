# Architect's plan — reliable substrate AND Poly back ASAP (2026-10-14)

## What we are building (one sentence)

A two-tier state substrate: small nodes share one budgeted, watched, fenceable Postgres; proven outliers live on their own database islands; one honest health read tells everyone which is which — and Poly is the first graduated tenant.

## The key decoupling (this is the Pareto insight)

**Poly's return does not need the automation.** Once Poly runs on its own cell (own VM, own disk), it physically cannot hurt neighbors — that guarantee is structural, zero code paths involved. The auto-containment controller and status surface (PR #2729) protect against the *next* noisy tenant. Couple them and Poly waits on everything; decouple and both goals finish sooner.

## Lane 1 — critical path: Poly up + fleet structurally safe (~1–2 days)

| # | step | owner | gates |
|---|------|-------|-------|
| 1 | Decide A; merge hub refinement 6b555902 | CEO | 5m |
| 2 | Flight PR #2730 alone; solo validation = inert for existing nodes + cell provision/status/release exercised + DSN rotation dry-run on candidate | dev session | 2–3h |
| 3 | Operator-merge #2730 (auto-previews; inertness proven, not assumed) | operator | queue |
| 4 | Provision Poly candidate cell → restore representative data → direct pgbench replay (≥8 clients, 2× incident rate) → neighbors stay green | dev session | 3–4h |
| 5 | Provision prod Poly cell → fenced final dump → restore → checksum verify → rotate Poly DSNs → enable → 5×1m two-region healthy → audited re-admission | dev session + CEO watch | 3–4h + VM lead time |
| 6 | Rollback retained: source DB read-only through the window; reversal = DSN flip + re-fence Poly only | standing | — |

After step 5: **Poly is live and the fleet's biggest proven risk is permanently structural-fixed** — even if Lane 2 slipped a week.

## Lane 2 — parallel, protects the NEXT Poly (no rush-to-merge)

Retarget #2729 to main after #2730 merges → combined candidate proof (hostile shared-tier replay → ≥40% attribution → auto-NOLOGIN before any neighbor SLO miss → audited human re-admission) → merge → 13-slot two-region exact-SHA proof → story.5085 closes. This is the "automatically contained" clause of Done-when; it gates the story, not Poly.

## Lane 3 — file now, build later (next stories, per the substrate standard)

1. **Control-plane graduation** — operator Postgres, Temporal, Doltgres, Redis still share one VM with the shared pool; the 2026-09-24 crash was non-Poly. This is the biggest residual risk once Poly graduates and the standing next graduation candidate.
2. **Substrate profiles for the named gaps** — Temporal (no namespace budgets), Doltgres (superuser, no bounds), Redis (no per-tenant memory) per `shared-substrate-tenancy-standard`'s ten-box gate.

## What this is NOT

Not building: stacked-PR CI machinery (option B), firewall automation transport, fleet-wide circuit breakers, or any Lane-3 item under incident pressure. Every one is a named follow-up with an owner gate.
