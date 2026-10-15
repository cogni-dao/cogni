# Independent design review — bug.5299 / `db-residency-follows-lane`

Reviewer: independent architect agent (not the design's author). 2026-10-13.
Design under review: hub contribution `contrib-flock-leader-conductor-9adc844a`,
entry `db-residency-follows-lane`, extending `noisy-neighbor-database-architecture`.

## Verdict: REQUEST CHANGES

| dimension              | score   |
| ---------------------- | ------- |
| Simplicity             | FAIL    |
| OSS-First              | PASS    |
| Architecture Alignment | CONCERN |
| Boundary Placement     | CONCERN |
| Content Boundaries     | CONCERN |
| Scope Discipline       | CONCERN |
| Risk Surface           | FAIL    |

## The two FAILs

**Simplicity.** "One cell of one table" is false. The real change set: one new
resolver, three `${VM_IP}` interpolations in `_compose_node_value`, four
name-derivation sites (`reconcile-secrets.sh`, `image-tags.sh:400`,
`deploy-infra.sh:1265` hardcoded and laneless, `assert-target-substrate.sh:264`
passing no lane), two Grafana datasource consumers, the `substrateHost` contract
comment at `compute-workload-manifest.ts:188-205`, and a provisioning host that
is currently just the SSH target. There is no host cell to move:
`secret-materialize.sh:148` reads `VM_IP` off the machine it SSH'd into.

**Risk Surface.** Three unhandled hazards:

1. _Rollback is destroyed by the fix._ Collapsing `lane_db_suffix` deletes the
   function that composes `cogni_red_candidate_a` — the name a rollback DSN must
   point at. Preserve it through the rollback window.
2. _Dual-writer password collision._ `deploy-infra.sh:1265` computes
   `cogni_${node//-/_}` hardcoded and laneless inside the remote heredoc and
   reconciles `app_<node>` from that VM's own OpenBao. After a suffix collapse,
   poly/candidate-a resolves to `cogni_poly` + `app_poly` on the candidate-a
   instance, where both already exist with a different password. That is
   bug.5207's destructive shape resurrected on the destination host, and the
   proposed equality gate covers only two of the four derivations.
3. _No destination capacity census._ Backends were censused on production and
   nothing on the targets, while bug.5299 itself refuses a production VM upsize
   without a RAM census. `db-backup`'s `MIN_FREE_MB=15000` floor applies per
   host; the 2026-09-03 disk-saturation incident recorded in `backup.sh:9-16` is
   the precedent for this failing on the receiving side.

## The blocking open question: trust direction

Provisioning `app_red` on the candidate-a instance requires production's vault
password at the candidate-a Postgres superuser. Every route is rejected or
unnamed:

- (a) production's run SSHes the candidate-a VM — a new cross-host primitive
  that hands the production reconciler root on a non-prod VM, widening
  production's blast radius in the direction the item is trying to shrink;
- (b) the candidate-a run reads production's vault — the up-trust inversion
  `run-node-substrate.sh:88-92` and `akash-actuator-wallet-cutover` explicitly
  reject;
- (c) secret custody follows the lane — breaks `CONTROL_AUTHORITY_UNMOVED`.

The design assumes this away. Until it is answered the design is not
implementable.

## What the review confirmed as correct

- The rationale claim holds: **nothing but secrets requires the database on the
  custodian.** Egress needs zero change (`render-compute-egress-allowlist.sh`
  already installs the identical CIDR union on all three VMs); backups
  auto-follow residency (`backup.sh:145` enumerates `pg_database` live);
  `<env>-db-reader` is read-only and vault-side, unaffected.
- Moving residency **removes** a latent defect (bug.5326): a node akash in
  candidate-a but not production gets no hole in production's 5432 today, i.e.
  it boots firewalled off its own database. This was the design's best unmade
  argument.
- The non-redundancy argument survives: the parent's graduation policy is
  monotone in _load_, so it provably cannot reach a 2-backend tenant. "Admission
  bounds rate; graduation bounds share. Neither bounds environment" is correct,
  and the growth term is structural — `control_env_for` relocates every Akash
  non-prod lane by construction, so each spawn adds production-resident
  databases regardless of traffic.

## Revised order of operations

0. **Drop every husk now.** No gate required; the design's gating rationale was
   factually false. `node_database_csv` is laneless and can only ever recreate
   _unsuffixed_ names, so it cannot recreate a lane-suffixed husk. `toks4` has
   no catalog row at all; `cogni_toks5_candidate_a` is outside `toks5.envs` and
   `reconcile-node-substrate.sh:216-220` fails loud rather than creating it.
1. **Collapse the third and fourth derivations** (`deploy-infra.sh:1265`,
   `assert-target-substrate.sh:264`) onto the shared lane-aware derivation.
   Standalone correctness fix, prerequisite for either task, no residency
   decision required.
2. **Resolver plus static CI gate**, one PR, before any move — computable with
   no live database access, same shape as `lane-db-name.test.sh`. State how a
   gate that must fail the preceding `main` gets merged.
3. **Answer the trust deadlock** as a named decision.
4. **Cede Poly's non-prod lanes to task.5246.** It is already dumping and
   restoring Poly's three lanes into dedicated cells; making those cells
   env-resident is one argument to a move already happening, versus a second
   independent cutover on the same instance in the same window. Removes 27 of
   31 misresident backends with zero new mechanism.
5. `red/candidate-a` and `toks5/preview` last — 2 peak backends each.

## Required amendments to the entry itself

- Fold `RESIDENCY_IS_NOT_TIER` and `ENV_IS_A_FAILURE_DOMAIN_NOT_A_NAME` into the
  parent's invariant block; the rule earns about four lines, not a sibling
  design entry governing four backends.
- Move the proof protocol out of canon into bug.5299's `outcome` — AGENTS.md:
  specs hold contracts and invariants, never a rollout plan — and reorder it to
  gate-before-move, matching the work item.
- Cut the Doltgres row or give it a mechanism: `DOLTGRES_URL` composes
  `knowledge_<node>` at the control env's immutable superuser password, which
  Doltgres 0.56.3 cannot `ALTER` (`databases.md §5.2`), so lane residency makes
  the embedded credential the wrong env's — a direct
  `CONTROL_AUTHORITY_UNMOVED` contradiction.
- Name Temporal, Redis and LiteLLM server custody as explicit residual risk, or
  narrow the title to Postgres residency. `SUBSTRATE_PORTS` is one host and the
  Rule table covers two of five services. Non-production Temporal workflow
  history still writes to the production VM's disk.
