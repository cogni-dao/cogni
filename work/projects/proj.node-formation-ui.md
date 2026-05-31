---
id: proj.node-formation-ui
type: project
primary_charter:
title: Node Formation & Launch
state: Active
priority: 1
estimate: 8
summary: Full node lifecycle from DAO formation through zero-touch provisioning. Covers web wizard, payment activation, node registry, and the provisionNode workflow (shared-cluster, namespace-per-node, Akash-forward).
outcome: Founder clicks "Launch Node" after DAO formation -> async workflow provisions shared-cluster namespace + repo + config -> node is live at {slug}.nodes.cognidao.org within 15 minutes. Zero manual steps.
assignees: derekg1729
created: 2026-02-07
updated: 2026-03-09
labels: [web3, setup, cli, legal]
---

# Node Formation & Launch

> Source: docs/spec/node-formation.md, docs/spec/node-launch.md

## Goal

Full node lifecycle: DAO formation (done) -> zero-touch provisioning (this project's primary gap). Extend formation to cover rewards-ready tokens and legal entity, then build the provisionNode workflow that eliminates all manual post-formation steps.

**North star:** Founder clicks "Launch Node" -> node is live. Shared cluster, namespace per node, Akash-forward.

> Research: [On-Chain Entity Formation (OtoCo)](../../docs/research/onchain-entity-formation-otoco.md) — OSS evaluation of OtoCo, KaliDAO, MIDAO for legal entity wrapping. Aragon remains the governance layer; OtoCo is complementary (legal identity only).

## Roadmap

### Crawl (P0) — Remaining P0 Items

**Goal:** Close remaining P0 gaps and make the token setup compatible with real contributor distributions.

| Deliverable                                                                                                                                                                                                                                         | Status      | Est | Work Item   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --- | ----------- |
| Rewards-ready mint mode — fixed `GovernanceERC20` supply minted to a DAO-controlled emissions holder, with server verification of holder + total supply                                                                                             | Not Started | 2   | `task.0135` |
| Automated e2e testing (DAO formation flow with testnet)                                                                                                                                                                                             | Not Started | 2   | —           |
| Encoding parity test: TokenVoting setup encoding must match Foundry exactly (`packages/aragon-osx/src/__tests__/encoding.parity.test.ts`). Fixture generation: Run Foundry script with known inputs, capture encoded bytes, commit as test fixture. | Not Started | 2   | —           |

### Crawl (P0b) — Payments Activation for Monorepo Nodes

**Goal:** Turn manual 3-step activation into one seamless `activate(nodeId)`, and prove the loop with a deployment-portable $2 live-money test. Design: [design.node-payments-activation](../../docs/design/node-payments-activation.md).

| Deliverable                                                                                                                                                   | Status      | Est | Work Item         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --- | ----------------- |
| `activate(nodeId)` — idempotent operator step: provision node wallet + deploy Split + write `nodes/<x>/.cogni/repo-spec.yaml` (replaces the 3 manual steps)   | Not Started | 3   | (create at start) |
| Rename `operator_wallet` → `node_wallet` in node-spec + `@cogni/repo-spec` schema/accessors (kills the "operator bound?" confusion)                           | Not Started | 1   | (create at start) |
| Per-node Privy secret namespace so no shared key controls multiple nodes (the only real operator-binding risk)                                                | Not Started | 2   | `task.5081`       |
| Make `test:external:money` deployment-portable — deep PG/TigerBeetle assertions now optional; HTTP + OpenRouter proof always runs against any `TEST_BASE_URL` | **Done**    | 2   | `task.0165`       |
| Run the $2 live-money e2e against a deployed monorepo node (candidate/preview); post scorecard                                                                | Not Started | 1   | `task.0165`       |

### Walk (P1) — Zero-Touch Node Launch + Node Registration

**Goal:** Build the provisionNode workflow so that DAO formation -> live node requires zero manual steps. Shared cluster, namespace per node.

| Deliverable                                                                                                         | Status      | Est | Work Item           |
| ------------------------------------------------------------------------------------------------------------------- | ----------- | --- | ------------------- |
| dns-ops package + create-node wizard — Cloudflare DNS automation, node-spec generation, protected record safeguards | In Review   | 3   | `task.0232`         |
| Design: extract node-template from operator repo — identity split, repo-spec v0.2.0 merge                           | Not Started | 5   | `task.0233`         |
| Design: node repo creation + CI/CD onboarding — git lifecycle, secrets, preview deploys                             | Not Started | 5   | `task.0234`         |
| provisionNode Temporal workflow — full provisioning chain (8 activities, idempotent)                                | Not Started | 8   | `task.0202`         |
| Node registration lifecycle — discovery, repo-spec fetch, scope reconciliation (absorbed from proj.operator-plane)  | Not Started | 5   | `task.0122`         |
| Operator-side `node_registry_nodes` table (see Design Notes §Operator Node Registry)                                | Not Started | 2   | (part of task.0202) |
| Wildcard DNS setup — `*.nodes.cognidao.org` -> cluster ingress (one-time)                                           | Not Started | 1   | (part of task.0232) |
| ArgoCD ApplicationSet — git-directory generator for `infra/cd/nodes/*`                                              | Not Started | 1   | (part of task.0202) |
| `POST /api/nodes/provision` + `GET /api/nodes/{id}/status` endpoints                                                | Not Started | 2   | (part of task.0202) |

### Walk (P1b) — Legal Entity + Multi-Holder

**Goal:** Optional on-chain LLC formation via OtoCo, multi-holder support.

| Deliverable                                                                                                     | Status      | Est | Work Item            |
| --------------------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| OtoCo testnet validation — verify Base Sepolia contracts, createSeries events, GovernanceERC20 token attachment | Not Started | 2   | `spike.0146`         |
| OtoCo ABI + receipt decoder — add OtoCo ABIs, implement receipt decoders for entity creation events             | Not Started | 2   | (create after spike) |
| Formation wizard TX 3+4 — optional "Incorporate as LLC" step, state machine extension                           | Not Started | 2   | (create after spike) |
| Server verification for OtoCo entity — extend verify endpoint, add `legal_entity` to repo-spec YAML output      | Not Started | 2   | (create after spike) |
| Multi-holder support (multiple initial token recipients)                                                        | Not Started | 2   | (create at P1 start) |

### Run (P2+) — npx End-to-End + Federation Enrollment

**Goal:** Full npx-based onboarding and federation enrollment.

| Deliverable                                                                                              | Status      | Est | Work Item            |
| -------------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| Evaluate P1 adoption before building npx flow                                                            | Not Started | 1   | (create at P2 start) |
| npx-based repo clone + init + DAO formation flow                                                         | Not Started | 3   | (create at P2 start) |
| Node-side persistence — Store formations in local `node_formations` table after verify succeeds          | Not Started | 2   | (create at P2 start) |
| Stable fingerprints — Verify endpoint emits `repo_spec_hash`, `cred_policy_hash`, `template_commit_hash` | Not Started | 2   | (create at P2 start) |
| Signed policy files — `.cogni/cred-policy.json` + `.cogni/cred-policy.sig` (detached signatures)         | Not Started | 2   | (create at P2 start) |
| Operator enrollment API — `POST /api/federation/enroll` with founder signature                           | Not Started | 2   | (create at P2 start) |
| Optional enroll UI — Post-formation button: "Enroll in Cogni Federation"                                 | Not Started | 1   | (create at P2 start) |

## Constraints

- Node Formation is Node-owned tooling — no Operator dependencies
- No private key env vars — all transactions signed via wallet UI
- Server derives ALL addresses from tx receipts (never trusts client)
- Rewards-ready formation must reuse the same `GovernanceERC20` later used for distributions; do not introduce a throwaway bootstrap token path
- Package isolation: `aragon-osx` cannot import `src/`, `services/`, or browser/node-specific APIs
- Import boundaries: `packages/setup-cli` → `packages/aragon-osx` allowed; → `src/*`, `services/*` forbidden
- **Do NOT build npx flow preemptively** — evaluate after P1 adoption

## Dependencies

- [ ] Foundry fixtures for encoding parity test
- [ ] Testnet infrastructure for automated e2e
- [ ] `task.0135` — rewards-ready token formation governance decisions + implementation
- [ ] `spike.0146` — OtoCo testnet validation (P1 entity formation depends on this)
- [ ] P1 adoption metrics before building npx flow

## As-Built Specs

- [node-formation.md](../../docs/spec/node-formation.md) — P0 formation invariants, tech stack, server verification, schemas
- [node-launch.md](../../docs/spec/node-launch.md) — Zero-touch provisioning: shared cluster, namespace-per-node, provider-agnostic
- [onchain-entity-formation-otoco.md](../../docs/research/onchain-entity-formation-otoco.md) — OtoCo research: OSS status, alternatives, crawl-walk-run plan

## Design Notes

### Operator Node Registry (P1)

**Purpose:** Operator-side derived index for control-plane functions (entitlements, service routing). Does NOT violate Node sovereignty.

**Source of Truth:** On-chain receipts + Node-authored `repo-spec.yaml`. Operator table is rebuildable from these.

**Table:** `node_registry_nodes` (Operator DB, not Node DB)

| Column              | Type | Notes                                  |
| ------------------- | ---- | -------------------------------------- |
| `node_id`           | UUID | PK, Operator's canonical tenant key    |
| `chain_id`          | INT  | Network identifier                     |
| `dao_address`       | TEXT | From DAORegistered event               |
| `token_address`     | TEXT | From TokenVoting.getVotingToken()      |
| `plugin_address`    | TEXT | From InstallationApplied event         |
| `signal_address`    | TEXT | From CogniSignal deployment receipt    |
| `formation_tx_hash` | TEXT | Auditable reference to on-chain tx     |
| `repo_spec_hash`    | TEXT | Proves Operator consumed Node's policy |
| `status`            | TEXT | pending → confirmed → (reorged if bad) |

**Write Rules:**

- Insert only after server-side receipt verification succeeds
- Upsert on `(chain_id, formation_tx_hash)` to prevent duplicates
- Never delete; mark `reorged` if invalidated

**Sovereignty Invariants:**

- No private keys stored (addresses + receipts only)
- Node operation does not depend on this table
- Operator can rebuild from on-chain data

> See: [Node vs Operator Contract](../../docs/spec/node-operator-contract.md)

### Federation Enrollment (P2+)

**Goal:** Federation legitimacy requires opt-in enrollment; hostile forks cannot inherit it.

**Build Order:**

1. **Node-side persistence** — Store formations in local `node_formations` table after verify succeeds
2. **Stable fingerprints** — Verify endpoint emits `repo_spec_hash`, `cred_policy_hash`, `template_commit_hash`
3. **Signed policy files** — `.cogni/cred-policy.json` + `.cogni/cred-policy.sig` (detached signatures)
4. **Operator enrollment API** — `POST /api/federation/enroll` with founder signature
5. **Optional enroll UI** — Post-formation button: "Enroll in Cogni Federation"

**Licensing Policy:** Source-available (PolyForm Shield); forks permitted. Federation benefits (badges, payouts, datasets) require enrollment with signed CogniCred config. Non-compliant forks lose federation features, not code access.

> Full spec: [Cred Licensing Policy](../../docs/spec/cred-licensing-policy.md)

**Scope guardrails:** Formation stays Node-owned. No on-chain registry in MVP. No multi-holder prerequisite.

### OtoCo Legal Entity Formation (P1)

> Research: [onchain-entity-formation-otoco.md](../../docs/research/onchain-entity-formation-otoco.md)

**Why OtoCo, not a governance replacement?** Aragon remains our governance layer (GovernanceERC20 + TokenVoting). OtoCo is a **complementary legal identity layer** — it wraps an existing DAO with a real-world LLC. OtoCo has [documented Aragon integration](https://legacy-docs.aragon.org/products/aragon-client/things-to-do-after-youve-started-a-dao/legal-integration-with-otoco). No governance conflict.

**Alternatives evaluated and rejected:**

- **KaliDAO** — has its own governance token + voting system. Would duplicate Aragon. Wrong fit.
- **MIDAO** — not OSS, requires Marshall Islands PPP intermediary. No smart contract integration.
- **DIY formation** — manual, not wallet-native. Defeats the purpose.

**Integration approach:** After DAO creation (TX 1) and CogniSignal deployment (TX 2), the wizard offers an optional "Incorporate as LLC" step:

- TX 3: `OtoCoMaster.createSeries(jurisdiction, controller, name)` — mints ERC-721 entity NFT
- TX 4: `attachToken(entityTokenId, aragonTokenAddress)` — mirrors token holders as LLC members

**Key design decisions:**

- **ENTITY_OPTIONAL**: Legal entity formation is opt-in. Nodes operate fine without it.
- **ENTITY_SERVER_VERIFIED**: Server derives entity details from OtoCo receipt (same trust boundary as DAO verification).
- **ENTITY_IN_REPO_SPEC**: Entity details recorded in `repo-spec.yaml` under `legal_entity` key.
- **NO_CUSTOM_CONTRACTS**: We call OtoCo's deployed contracts, not deploy our own.

**Financial Ledger interaction:** OtoCo's `attachToken()` reads GovernanceERC20 holders for LLC membership mirroring. After `task.0135` (rewards-ready mint), the emissions holder address will appear as a "member." This is cosmetic — OtoCo membership is informational, not governance-binding. Token distribution via MerkleDistributor (`proj.financial-ledger`) is unaffected.

**Pricing:** $99/year Delaware LLC, $99/year Wyoming LLC. Annual fee for registered agent service.

**Risk:** If OtoCo disappears, the LLC still exists in state records but renewals require manual filing. The OtoCo smart contracts are OSS ([github.com/otoco-io/SmartContract](https://github.com/otoco-io/SmartContract)) and audited (Coinspect 2022), so worst case we could fork the frontend.
