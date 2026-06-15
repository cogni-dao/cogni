# Cogni Technical Roadmap

> [!CRITICAL]
> Node sovereignty is non-negotiable. Every architecture decision preserves fork freedom and DAO wallet custody.

## Mission

**The Operator is the product** — an AI application that runs the gitops, deployments, billing, and health of a growing network of sovereign DAO nodes. It reviews, governs, and **merges** the network's code; flights and promotes its deployments; and (vNext) attributes contribution and pays out credits.

A **Node** is a sovereign DAO+app that any organization forks from `node-template` and runs independently. The Operator is itself just another node (`nodes/operator/app/`, same hex architecture) — with special powers. Nodes can consume Operator services, self-host OSS versions, or skip them entirely.

→ See: [Node vs Operator Contract](docs/spec/node-operator-contract.md) · [Development Lifecycle](docs/spec/development-lifecycle.md)

---

## Stage Honesty

We are **crawling**: one developer, near-zero external users, MVP. The bar for every increment is "one flow works end-to-end on the real candidate deployment," not platform-grade abstractions. Prefer proven OSS and in-repo features over new deployment surfaces. Anchor strategy to this reality, not to a future org chart.

---

## Non-Negotiable Invariants

| Invariant               | Meaning                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Wallet Custody**      | A node's DAO wallet keys never touch Operator infrastructure                                                 |
| **Data Sovereignty**    | Node DB is source of truth; Operator may cache but never requires custody                                    |
| **Fork Freedom**        | Node repo is forkable and runnable without Cogni accounts                                                    |
| **Repo-Spec Authority** | Node authors policy in `.cogni/repo-spec.yaml`; Operator consumes the snapshot+hash and never invents policy |

→ Full list + boot seams: [Node vs Operator Contract](docs/spec/node-operator-contract.md)

---

## Where We Are (as-built)

The Feb-2026 "three separate daemons" plan was superseded: review and governance consolidated **in-process** into the Operator app, and the Operator became a first-class node rather than a separate control-plane tier.

| Capability                       | State                                                                                                                                                                                          | Where                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Node formation**               | Live; weekly wizard bootstraps. Wizard forks `node-template`, pins the node repo as a submodule, opens an operator-authored deployment PR (catalog + overlays×3 + AppSets×3 + edge route).     | `nodes/operator/app/src/features/setup/`, `nodes/*`, [node-formation](docs/spec/node-formation.md)     |
| **AI orchestration (LangGraph)** | ~10 graphs live in-process (pr-review, operator, pr-manager, research, autoresearch, brain, browser, frontend-tester, poet, ponderer). No separate langgraph-server or top-level `evals/` dir. | `packages/langgraph-graphs/src/graphs/`                                                                |
| **PR review**                    | Live, in-process: gate orchestrator + `pr-review` graph → GitHub check run + comment, gates from `.cogni/repo-spec.yaml`.                                                                      | `nodes/operator/app/src/features/review/`                                                              |
| **DAO governance loop**          | Ported in-process: review-fail → on-chain proposal → vote → CogniSignal `CogniAction` → re-verify → GitHub action (merge/grant/revoke).                                                        | `nodes/operator/app/src/features/governance/`, [dao-governance-loop](docs/spec/dao-governance-loop.md) |
| **Deploy pipeline**              | `candidate-flight` (slot lease, digest promotion, Argo reconcile, buildSha verify) → preview → prod promote. Per-env node-set gate (deploy ⊆ provisioned).                                     | `.github/workflows/candidate-flight.yml`, [ci-cd](docs/spec/ci-cd.md)                                  |
| **Substrate**                    | OpenBao + ESO secrets SSOT, per-node Postgres roles, OpenFGA authz spine, per-node DNS reconcile.                                                                                              | `infra/k8s/argocd/`, [cicd-secrets-expert]                                                             |
| **Knowledge hub**                | Dolt + Doltgres + DoltHub mirror; recall→refine write pipeline (v0).                                                                                                                           | `nodes/operator/app` + knowledge skills                                                                |
| **Poly copy-trading**            | Live in production (a real node fixture exercising the rails).                                                                                                                                 | `nodes/poly/`                                                                                          |

---

## Current Frontier (actively converging)

| Track                              | Goal                                                                                                                                                                                                                                                | Anchor                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Operator as merge authority**    | One merge chokepoint (`VcsCapability.mergePr`) + deterministic policy router; operator authorizes routine merges on `deploy_verified`, node-formation merges on a capacity gate, and governance overrides on-chain. Contributors stop self-merging. | [merge-authority](docs/spec/merge-authority.md)                                     |
| **Zero-touch node formation**      | Founder clicks "Launch Node" → live across envs with no privileged manual bridge. First-class VM-capacity awareness (where to slot a node, when to make a VM) is the gate beyond ~6 nodes.                                                          | [proj.node-formation-ui](work/projects/proj.node-formation-ui.md)                   |
| **Dev-session capture**            | Capture AI-dev sessions to Postgres (append-only corpus) + additive analytics view — the contributor record that feeds future attribution.                                                                                                          | PR #1440, [proj.development-workflows](work/projects/proj.development-workflows.md) |
| **Deploy/observability hardening** | Stabilize preview/prod rollouts; ship infra events to Loki so the operator can see its own health.                                                                                                                                                  | [proj.observability-hardening](work/projects/proj.observability-hardening.md)       |

---

## vNext (not yet — ~next month+)

| Track                                        | Gate                                                                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Transparent credit payouts / attribution** | Epoch ledger: source adapters → enrichers → allocations → admin-finalized, deterministic statements. Operator merges + dev sessions become attribution receipts. | [proj.transparent-credit-payouts](work/projects/proj.transparent-credit-payouts.md), [attribution-ledger](docs/spec/attribution-ledger.md) |
| **VM-capacity-aware placement**              | Operator models VM capacity, slots new nodes, provisions VMs on demand. Replaces the flat node-count ceiling.                                                    | —                                                                                                                                          |
| **Operator repo extraction**                 | Extract Operator to its own repo; this repo becomes pure node template. **Gate: one paid customer + one real cred-informed payout.**                             | [proj.operator-plane](work/projects/proj.operator-plane.md)                                                                                |

---

## Guardrails

- No Operator repo extraction until: one paid customer + one real cred-informed payout.
- No per-service standalone UIs without paying users.
- Every cross-boundary call via an explicit, versioned contract.
- LLM-facing changes require eval regression gates.
- Same deploy path, different config: preview and prod use identical images.
- No LLM in the merge path — merge authorization is deterministic policy; rebase/serialization is GitHub Merge Queue (`NO_AGENTIC_REBASE`).
- Canonical tenant key is `billing_account_id` (DB) / `tenantId` (runtime) — same UUID = `billing_accounts.id`. No new synonyms.

---

## Appendix: Identity & Tenant Scoping

| Term                 | Layer      | Value                             | Purpose                                                                              |
| -------------------- | ---------- | --------------------------------- | ------------------------------------------------------------------------------------ |
| `billing_account_id` | DB column  | `billing_accounts.id` (UUID)      | Canonical tenant key for RLS, FK references, data isolation                          |
| `tenantId`           | Runtime    | Same UUID as `billing_account_id` | Canonical name in tool/workflow contexts                                             |
| `node_id`            | Deployment | `.cogni/repo-spec.yaml` (UUID)    | Deployment/instance identity. One node = one DB, one infra. Never governance scoping |
| `scope_id`           | Governance | `.cogni/projects/*.yaml` (UUID)   | Governance/payout domain (project). `uuidv5(node_id, scope_key)`                     |
| `user_id`            | Person     | `users.id` (UUID)                 | Auth-method-agnostic person identity; attribution + payouts                          |
| `actor_id`           | Economic   | `actors.id` (UUID)                | Economic subject that earns/spends/is attributed                                     |
| `dao_address`        | On-chain   | Contract address                  | Attribute of a scope, not a tenant key                                               |

**Rules:** `billing_account_id`(DB) ≡ `tenantId`(runtime). `node_id` = deployment only, never governance/RLS. `scope_id` = governance only, never deployment routing. Do NOT introduce synonyms (`org_id`, `account_id`, `project_id` DB column). V0 default: `scope_id = 'default'`; multi-scope activates with `.cogni/projects/*.yaml`.

→ Full taxonomy: [Identity Model](docs/spec/identity-model.md)

---

## Related Docs

| Doc                                                              | Purpose                                            |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| [Node vs Operator Contract](docs/spec/node-operator-contract.md) | Boundaries, invariants, boot seams                 |
| [Development Lifecycle](docs/spec/development-lifecycle.md)      | idea → deploy_verified status machine + agent loop |
| [Merge Authority](docs/spec/merge-authority.md)                  | Operator as the network's merge authority          |
| [DAO Governance Loop](docs/spec/dao-governance-loop.md)          | Review → vote → signal → merge override            |
| [Node Formation](docs/spec/node-formation.md)                    | DAO formation + node birth                         |
| [Attribution Ledger](docs/spec/attribution-ledger.md)            | Epoch attribution + payouts (vNext)                |
| [CI/CD](docs/spec/ci-cd.md)                                      | Environments, deploy branches, candidate-flight    |
| [Identity Model](docs/spec/identity-model.md)                    | All identity primitives                            |

---

**Last Updated**: 2026-06-11
**Status**: Operator-centered; reflects in-process consolidation (governance + review) and the merge-authority convergence
