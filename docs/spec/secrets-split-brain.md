---
id: spec.secrets-split-brain
type: spec
title: Secrets Split-Brain — How `.env`/`_shared` Drift Lives
status: draft
trust: draft
summary: Precise mechanism of the recurring secrets-drift outage class — one logical `shared` secret materialized into three physical copies (`_shared` SSOT, per-node inherited copy, VM `.env` render) that no writer keeps in lockstep. Names the writers, where they diverge, the prod evidence, the three-layer fix, and the falsification gate.
read_when: Debugging a Compose-service auth failure (`401`/`28P01`) that smells like a stale credential; deciding whether to "heal" toward `.env`; designing the `deploy-infra` OpenBao render or the `_shared`-purge; auditing why a secret outage recurred.
owner: derekg1729
created: 2026-06-12
verified: 2026-06-12
tags:
  - secrets
  - drift
  - incident
  - openbao
---

# Secrets Split-Brain

## The problem in one sentence

One logical secret is materialized into several physical copies that **no writer keeps in lockstep**; a consumer that trusts the wrong copy fails auth. This is the recurring root of secrets outages.

## How it lives — three copies of one `shared` secret

A `shared: true` A1 secret (`LITELLM_MASTER_KEY`, `OPENROUTER_API_KEY`, `BILLING_INGEST_TOKEN`, `METRICS_TOKEN`, …) is **declared once** at `cogni/<env>/_shared/<KEY>` (see [`secrets-classification.md`](./secrets-classification.md) §A1 `shared:` flag). To reach its consumers it is physically **copied into up to three independent stores**:

| #   | Copy                        | Path / file                                  | Written by                                                                | Read by                                          |
| --- | --------------------------- | -------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | **SSOT**                    | `cogni/<env>/_shared/<KEY>`                  | `secret-materialize` (generates `source: agent`; preserves existing)      | the inherit + render steps below                 |
| 2   | **Per-node inherited copy** | `cogni/<env>/<node>/<KEY>`                   | `secret-materialize::inherit_shared_value` (copies `_shared` → node path) | ESO → k8s `<node>-env-secrets` → pod `envFrom`   |
| 3   | **VM `.env` rendered copy** | `/opt/cogni-template-runtime/.env` `<KEY>=…` | `deploy-infra.sh` (reads OpenBao, writes `.env`)                          | Compose containers (litellm, temporal, alloy, …) |

Three writers, three copies, **no enforced lockstep.** The pod reads copy **#2**, not the SSOT — its ExternalSecret extracts `cogni/<env>/<node>`, not `_shared`. Compose reads copy **#3**. The SSOT **#1** is only a _source_ for #2 and #3; if it is empty or stale, #2 and #3 silently disagree.

## Where it breaks

- **`_shared` empty.** If `secret-materialize` never populated `_shared` for an env (prod's `<env>-writer` SA was missing — bug.5007), `_shared` stays empty while #2 and #3 were seeded independently from older provisioning / GitHub-env inputs → divergence by construction.
- **A `deploy-infra` re-render.** It rewrites copy #3 from its source and restarts the container. If that source disagrees with copy #2 (the pod) or the live DB role, the restarted container now fails auth → silent `401` / `28P01`.
- **A hand-edit of `.env`** (the emergency band-aid) → copy #3 diverges from OpenBao until the next render overwrites it.

## Evidence — prod, 2026-06-12

| Secret                                        | #1 `_shared` | #2 `operator/` (pod)         | #3 `.env` (Compose)           | Symptom                                          |
| --------------------------------------------- | ------------ | ---------------------------- | ----------------------------- | ------------------------------------------------ |
| `LITELLM_MASTER_KEY`                          | empty        | value A                      | value B                       | litellm `401` → no chat, no PR-review graph exec |
| `BILLING_INGEST_TOKEN`                        | empty        | `29adae9e` (app = validator) | `160f91a7` (litellm = sender) | billing callback `401`, spend unrecorded         |
| `OPENROUTER` / `METRICS` / `SCHEDULER` tokens | empty        | value                        | divergent value               | same class                                       |
| temporal / doltgres superuser                 | —            | (live DB role)               | `.env`                        | `28P01` after a `deploy-infra` bounce            |

A `deploy-infra` run that re-rendered copy #3 from the empty/wrong source is what flipped all of these from dormant to active at once.

## The tell

**k8s pods have no `.env`** — ESO reads OpenBao → `envFrom`, one read path; they rarely drift. **Every `.env`-bound Compose service is the drift surface.** If the broken consumer is a Compose container, suspect this first.

## The fix — three layers

1. **Never heal toward `.env`** ([`secrets-management.md`](./secrets-management.md) Invariant 15 / bug.5002 anti-fix). Do not `ALTER ROLE … ` to a rendered `.env` value or align a container to its copy. Align the **source** (OpenBao) or kill the copy. Healing toward `.env` makes `deploy-infra` a second writer and guarantees the next divergence.
2. **`deploy-infra` reads OpenBao, set-once** ([`secrets-management.md`](./secrets-management.md) Phase 2). The `.env` render is always sourced from OpenBao, never GitHub-env, never a second writer. This makes copy #3 _correct_ — but it still exists, so it can still drift on a hand-edit or a stale source.
3. **Eliminate the copies (endgame):**
   - **Purge the `_shared` bucket** → owner-scoped paths + explicit per-consumer read grants ([`secrets-classification.md`](./secrets-classification.md) "Owner-scoped paths, not a `_shared` bucket"). Removes copy #2's inherit-by-copy.
   - **Purge the server `.env`** → Compose reads OpenBao directly via a **Bao Agent** sidecar, or those services migrate into k8s where **ESO already does this with no `.env`**. Removes copy #3.
   - No copy → nothing to drift → the class is gone.

## Falsification gate

Delete a `.env` value on the VM, redeploy, and prove the service comes up green **from OpenBao only**. Passing this proves the copy is gone (or always re-rendered from the single source). It is the acceptance test for "this can't resurface" — do not claim a durable fix without it.

## Related

- [`secrets-management.md`](./secrets-management.md) — Invariant 5 (OpenBao SSOT), 15 (bug.5002 anti-fix), the Phase-2 migration.
- [`secrets-classification.md`](./secrets-classification.md) — A1 `shared:` flag (copies #1↔#2), B-tier `.env`/Bao-Agent render (copy #3), the `_shared`-purge roadmap.
- [`secrets-rotate.md`](../guides/secrets-rotate.md) — the static-DB-role rotation (the "won't self-heal" lockstep procedure).
