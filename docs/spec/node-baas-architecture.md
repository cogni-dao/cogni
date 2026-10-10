---
id: spec.node-baas-architecture
type: spec
title: Node Backend-as-a-Service Architecture
status: draft
trust: draft
summary: "Product and package shape for node-at-repo-root repos: app code, node-owned graphs and durable workflows, managed substrates, and the MVP path from today's node-template."
read_when: "Designing node-template at repo root, deciding node package/service layout, adding node-owned graphs, durable workflows, Postgres, or Doltgres packages, or planning node wizard MVP scope outside CI/CD."
implements: []
owner: cogni-dev
created: 2026-06-05
verified: 2026-10-09
tags:
  - node-template
  - packages
  - databases
  - knowledge
  - node-formation
---

# Node Backend-as-a-Service Architecture

## Context

The [Node CI/CD Contract](./node-ci-cd-contract.md) defines how a submodule node is born, built, pinned, flighted, and promoted. This spec defines the adjacent product shape: what a node repository should look like once `node-template` is a proper **node-at-repo-root** repo.

The useful analogy is Supabase's backend-as-a-service model. A Supabase project centers on Postgres, then exposes integrated services around it: Auth, generated API, Realtime, Storage, Functions, pooler, dashboard, and CLI. Their architecture principle is that tools work in isolation but integrate through APIs and webhooks; their local CLI starts a full local stack rather than only app code. See [Supabase architecture](https://supabase.com/docs/guides/getting-started/architecture) and [Supabase local development](https://supabase.com/docs/guides/local-development).

Cogni should apply the same product idea to AI nodes: a node is not just a Next.js app. It is an app plus managed operational data, versioned knowledge, graph execution, identity, streams, secrets, and deployment declarations. The operator manages substrate provisioning; the node owns code and declarations.

## Goal

Define the stable node repo shape that makes a freshly minted node:

- usable as a standalone developer project;
- inspectable as a small product, not a copied monorepo fragment;
- able to build and push its own image;
- able to declare database, knowledge, graph, secret, and service shape without editing the operator plane;
- compatible with operator-hosted deployment through submodule pinning.

## Non-Goals

- CI/CD workflow details; see [Node CI/CD Contract](./node-ci-cd-contract.md).
- Operator provisioning internals: catalog rendering, AppSets, Caddy routes, OpenBao bootstrap, Argo, DNS.
- A Supabase clone. Cogni should reuse the BaaS mental model, not its exact service list or implementation choices.
- Pre-scaffolding every possible package for every node. Empty packages are tax unless the template needs them on day one.

## Core Model

A node has two sides:

| Side                  | Owner          | Examples                                                                                                                 |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Node product**      | node repo      | `app/`, `packages/`, `k8s/base/`, `.cogni/rules/`, schema declarations, graph definitions                                |
| **Managed substrate** | operator plane | per-env DB provisioning, OpenBao values, ESO manifests, overlays, AppSets, gateway routes, candidate/preview/prod flight |

The node declares **shape**. The operator provisions and connects that shape per environment.

This is the same split already used for submodule nodes: the node repo owns app, packages, base manifests, local policy, and image build; the operator owns catalog, overlays, AppSets, provisioning, flight, and promotion.

### Spawn activity authority — generation 1

Every merged `type: node` catalog row projects three environment-sensitive facts into each
environment's local operator registry: the non-empty `deploy_envs` set, one `activity_env`, and the
stable owner wallet (resolved to that environment's own user row). A deployment is allowed to serve a
node without owning its activity ledger. Epoch schedules are created only when both conditions hold:

1. the local `DEPLOY_ENVIRONMENT` is present in `deploy_envs`; and
2. it exactly equals `activity_env`.

The v1 spawn protocol is deliberately fixed: a fresh wizard node is born with
`deploy_envs=[candidate-a]` and `activity_env=candidate-a`. This is **authority generation 1**, a
non-transferable initial state—not a claim that a catalog edit can atomically move authority. Preview
or production may later be added as passive deployments, but the env-management route rejects removal
of the final deployment and rejects removal of the current activity environment.

There is no production activity-authority cutover in v1. A future cutover must first specify a durable,
monotonic generation/fencing token and a two-phase `old authority quiesced → new authority active`
protocol that recovers across partial git/DB/Temporal failure. Until that lands, manually changing
`activity_env` is unsupported. Cross-environment webhook relay is a separate transport concern and is
not part of this registry projection slice.

### A node is a bundle, not a service — `node → services → deployments`

A **node is a codebase bundle**, not a single deployable. One node repo can build
**many independently-deployable units** — the Next.js `app/`, a Temporal worker under
`services/`, a migrator, future co-services — each with its **own image, its own
health, and its own scaling**. Calling a node "a service" (or assuming it _is_ the
Next.js app) is a category error: the app is one unit the node produces.

```text
Node              codebase bundle · identity = repo-spec node_id
  └─ 1:N  Service / deployable unit   app · worker · migrator · …   (own build + scaling)
        └─ 1:N  Deployment = (node, service, env) cell              the thing that runs, per env
```

**The deployment unit is `(node, service, env)`, not `(node, env)`.** A node's worker
can run 5 replicas in production while its app runs 1 — same node identity, different
services, independent scaling. `node_id` is the join key (identity · UI · RBAC ·
catalog projection); each **service** of that node is what actually deploys and scales.

> **Today's reality + the gap.** Most nodes ship only the `app/` unit, and their recurring
> graph/route work still runs on the centralized compatibility Worker. The target makes a
> private node-owned Workflow Worker a standard service rather than an escape hatch. P0 deploys
> app + Worker as co-located services in one workload revision; independent per-service scaling
> remains forward work because the catalog still models one deployable workload per row.

### Node-controlled surfaces

A sovereign node must be able to change these without an operator code PR:

| Surface           | Node-owned artifact                                                                               | Operator reaction                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Operational data  | `packages/postgres` schema and migrations                                                         | provision/apply the node's Postgres migration against that node's DB                  |
| Knowledge data    | `packages/doltgres` schema and migrations                                                         | provision/apply the node's Doltgres migration, then commit DDL into Dolt history      |
| Graph behavior    | `packages/graphs` catalog and definitions                                                         | route execution to the node image and observe runs                                    |
| API/tool surface  | node-local `packages/contracts` or `app/src/contracts`                                            | expose only through the node app image unless promoted to shared contracts            |
| Secrets           | `.cogni/secrets-catalog.yaml` key declarations                                                    | create OpenBao paths, ESO manifests, and per-env values                               |
| Storage           | `.cogni/node.yaml` bucket/object declarations                                                     | provision object store credentials and lifecycle policy                               |
| Streams           | `.cogni/node.yaml` stream declarations and event contracts                                        | provision Redis/SSE/WebSocket substrate when enabled                                  |
| Durable workflows | Temporal client + `packages/workflows` + private `services/workflow-worker` + `RecurringWorkPort` | provision per-node namespace/identity; deploy app + Worker from one source-SHA bundle |
| Runtime shape     | `k8s/base`, health endpoints, ports                                                               | render overlays, AppSets, gateway routes                                              |

The operator may reject invalid declarations, but it should not require a root package or infra code edit for routine node evolution.

### Node→Temporal seam (recurring work)

Recurring work is a node-controlled surface, fully specified elsewhere — the row above
is the summary. The **target substrate model** (node-direct schedule creation, a private
node-owned Worker, and one namespace per node/environment, with the centralized Worker retained
only as a migration compatibility lane) is in
[Temporal Substrate](./substrate-temporal.md). The **execution model**
(`NodeTaskWorkflow` / `GraphRunWorkflow`, grant↔node binding, the per-node dispatch
principal, decommission teardown) is in
[Temporal Patterns § Node-as-tenant](./temporal-patterns.md).

## Node-at-Repo-Root Layout

Target layout:

```text
.
├── app/
├── packages/
│   ├── graphs/
│   ├── postgres/
│   ├── doltgres/
│   ├── contracts/
│   └── domain/
├── k8s/
│   └── base/
├── .cogni/
│   ├── repo-spec.yaml
│   ├── node.yaml
│   ├── rules/
│   └── secrets-catalog.yaml
├── .github/
│   └── workflows/
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.json
├── biome.json
└── Dockerfile
```

This is the node-repo view. In the operator monorepo, the same repo appears only as a gitlink at `nodes/<slug>` plus operator-owned catalog/overlay/appset rows.

### `app/`

The runtime application. Today this is the Next.js node app. It owns framework glue, request handlers, UI, bootstrap composition, env assertion, and runtime adapter wiring.

`app/` may import node-owned packages and cross-node baseline packages. Packages must not import `app/`.

### `packages/graphs`

Node-owned graph catalog and graph definitions.

This should be a package when graphs are reusable definitions imported by `app/`, tests, or future workers. If a graph process has lifecycle, the lifecycle entrypoint belongs in `services/`; the graph definitions still belong here.

Current state: the monorepo already has `nodes/<node>/graphs`. For node-at-root, prefer `packages/graphs` unless there is a concrete lifecycle reason to keep a top-level `graphs/` workspace.

### `packages/postgres`

Node-owned operational database package. Suggested package name: `@cogni/<node>-postgres`.

Responsibilities:

- node-local Drizzle schema slices for operational tables;
- inferred row types and public schema exports;
- typed client factory helpers that are schema-coupled but do not load env;
- optional pure adapters that take a DB client as constructor input.

Non-responsibilities:

- runtime env loading;
- root/superuser provisioning;
- per-env DSN construction;
- migrations execution lifecycle.

Those stay in `app/`, CLI scripts, or the operator plane.

Why `postgres` instead of `postgresdbclient+schema`: schema and typed client are coupled enough to live together, but the folder name should stay short and product-readable. The package contents can expose subpaths like `./schema`, `./client`, and `./adapters`.

Do not create this package until the node has node-local operational tables. Core tables shared by every node stay in the cross-node `@cogni/db-schema` / `@cogni/db-client` layer.

### `packages/doltgres`

Node-owned knowledge database package. Suggested package name: `@cogni/<node>-doltgres`.

Responsibilities:

- Doltgres-only Drizzle schema slices;
- inferred row types;
- typed knowledge adapter/client helpers;
- Dolt-specific helpers for commit, log, and diff when they are pure and reusable.

Non-responsibilities:

- operational tables;
- Postgres migrations;
- env loading;
- branch/merge workflow daemons.

The [database-expert skill](../../.claude/skills/database-expert/SKILL.md) and [Knowledge Data Plane](./knowledge-data-plane.md) remain authoritative on the Postgres-vs-Doltgres split: Postgres is hot operational data; Doltgres is AI-written or AI-refined knowledge with useful version history.

The package should avoid table sprawl. Default to generic knowledge rows with `domain` and `tags`; add companion tables only for true entities with distinct columns.

### `packages/contracts`

Optional node-specific API, tool, and event contracts.

Use this when a node has contracts that should be imported by `app/`, graphs, tests, or external node clients but are not universal enough for root `@cogni/node-contracts`.

### `packages/domain`

Optional node-specific pure domain logic.

Use this for policy, scoring, math, and typed domain objects that are not framework-bound and are not cross-node. Do not use it as a dumping ground for feature code.

### `k8s/base`

Node-owned deploy shape only: Deployment/Service shape, ports, health endpoints, and any node-local base manifest that describes what the app is.

Per-env overlays, AppSets, gateway routes, catalog rows, secret values, DNS, and environment ownership stay in the operator plane.

### `.cogni/`

Node control metadata:

- `repo-spec.yaml`: node identity and on-chain bindings;
- `node.yaml`: declared capabilities and substrate requirements;
- `rules/`: review rules and node-local policy;
- `secrets-catalog.yaml`: secret key shape only, never values.

A minted node must be born-reviewable: `.cogni/rules/` ships in the node repo before the first PR against that repo.

## BaaS Substrate Map

Cogni's BaaS surface should be small, composable, and portable:

| Cogni substrate         | Node declares                                                                                                                                                      | Operator provides                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres                | `packages/postgres`, migrations, required DSNs                                                                                                                     | per-node DB, roles, RLS hardening, backups                                                                                                                                                                                                                                             |
| Doltgres                | `packages/doltgres`, migrations, knowledge domains                                                                                                                 | per-node `knowledge_<node>` DB, migrator wiring, commit validation                                                                                                                                                                                                                     |
| Auth/RLS                | app routes and tenant context usage                                                                                                                                | app/service/read-only roles, DSN secrets                                                                                                                                                                                                                                               |
| Authorization           | authz checks + protected actions in app routes; capability gating in the secrets fan                                                                               | shared OpenFGA store/model, env-shared authz graph, `OPENFGA_*` runtime-config delivery, DB role + backup                                                                                                                                                                              |
| Graphs                  | `packages/graphs` definitions                                                                                                                                      | execution host, routing, observability substrate where shared                                                                                                                                                                                                                          |
| Durable Agent Workflows | `packages/graphs`, `packages/workflows`, private `services/workflow-worker`, schedules, and node-direct `RecurringWorkPort`; app + Worker ship from one source SHA | shared Temporal service; one namespace/runtime identity per `(node, env)`; secret, deployment, visibility, and lifecycle wiring; published starter runtime from node-template — see [Temporal Patterns](./temporal-patterns.md) and [LangGraph Patterns](./langgraph-patterns.md)      |
| Streams                 | event contracts and consumers                                                                                                                                      | Redis/SSE/WebSocket substrate where needed                                                                                                                                                                                                                                             |
| Storage                 | bucket/object metadata expectations                                                                                                                                | object store, credentials, lifecycle policies                                                                                                                                                                                                                                          |
| Secrets                 | key names and consumers                                                                                                                                            | OpenBao values, ESO manifests, rotation path                                                                                                                                                                                                                                           |
| Observability Access    | which substrates it emits to (logs / AI traces / analytics / DB)                                                                                                   | per-node-scoped READ on `developer` grant — operator **proxies** the query pinned to the node (`{node="<id>"}` for Loki, `nodeId=<id>` for Langfuse AI traces; dev holds no env-wide token), not a credential issuer — see [Substrate Access-Grant Plane](./substrate-access-grant.md) |
| Gateway                 | service ports and health routes                                                                                                                                    | domain, TLS, Caddy/ingress, per-env route                                                                                                                                                                                                                                              |
| Studio/Wizard           | node metadata and capabilities                                                                                                                                     | operator UI, publish, flight, validation                                                                                                                                                                                                                                               |
| Cognition               | knowledge entries (skills/guides/playbooks), registered domains                                                                                                    | session-start kickstart bundle (`/api/v1/cognition`), advertised via `/.well-known/agent.json`                                                                                                                                                                                         |

The invariant is: **node declares shape; operator wires environment**.

### Durable agent workflow substrate

The node-sovereign unit is not a naked LangGraph graph and not an operator-owned scheduled
callback. It is a **durable agent workflow**: node-owned Temporal orchestration containing one
or more node-owned LangGraph graph runs. The split follows the same successful pattern as the
knowledge and work-item substrates:

| Layer                | Lives where                                                              | Owns                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Product definitions  | node repo `packages/graphs` + `packages/workflows`                       | prompts, tools, graph topology, workflow sequencing, signals, timers, result policy                                    |
| Process lifecycle    | node repo `services/workflow-worker`                                     | Worker registration, Activity adapters, health, metrics, graceful shutdown                                             |
| Reusable SDK/runtime | immutable `@cogni-dao/agent-workflow-runtime` release from node-template | starter scheduled graph/route workflows, schedule contracts, retry profiles, Worker bootstrap; no node business policy |
| Managed substrate    | operator                                                                 | Temporal service, per-node namespace and runtime identity, secrets, placement, observability, add/remove lifecycle     |

The private service opts into `runtime_profile: cogni-workflow-worker-v1`. The profile, rather
than each node spec, owns the standard Temporal connection/auth/namespace/queue/health contract;
the operator also derives its `NODE_APP_URL` from the required app-profile sibling. The node
declares only extra secrets and non-standard sibling bindings. This extends the existing
`cogni-node-app-v1` pattern to a second named capability profile.

The profile is initially a candidate/preview contract. Production materialization remains
fail-closed until the shared self-hosted Temporal server enforces namespace-scoped authentication
and authorization; namespace naming alone is not accepted as tenant isolation.

The node-template carries the source package and default Worker service. CI publishes an
immutable, attested GitHub Release tarball; consumers pin the exact release, as Poly already
does for knowledge and work-item packages. A published package cannot contain `workspace:*`
runtime dependencies. Node-specific workflows stay in the node repository and release with
that node; they are never copied into or dynamically loaded by a centralized Worker.

The existing multi-service artifact bundle already provides the deployment primitive: the
public app and private Worker are exact-set artifacts from one source commit and materialize as
one workload revision. This prevents the schedule creator and poller from silently shipping
different code. Operator governance/ledger workflows remain operator-owned services; only
node product workflow ownership moves.

Migration uses a separate app client contract: legacy `TEMPORAL_*` and
`SCHEDULER_WORKER_HEALTH_URL` remain pointed at the centralized compatibility lane, while
`AGENT_WORKFLOW_TEMPORAL_*` and `AGENT_WORKFLOW_WORKER_HEALTH_URL` select the node namespace and
private Worker. P0 sends only explicit `workflow` schedule targets through that client; existing
`graph` and `route` targets stay on the compatibility lane. Merely adding the Worker profile
therefore cannot reroute, duplicate, or orphan existing scheduled work.

## Cognition Substrate

Supabase delivers Auth, Storage, and a generated API as managed services. The same product idea applies to an agent's **working cognition**: an agent should not have to git-sync a tree of `AGENTS.md` files to learn how to operate a node. The node is the subject-matter expert for its niche ([`knowledge-syntropy-expert`](../../.claude/skills/knowledge-syntropy-expert/SKILL.md)); its knowledge hub is the codified mind. So the operator serves that mind as a substrate, fetched at session start.

**Endpoint.** `GET /api/v1/cognition` returns a node's kickstart bundle, advertised under `cognition` + `endpoints.knowledgeBootstrap` in `/.well-known/agent.json`. The bundle has five parts:

| Part               | Source                                                                     | Owner         |
| ------------------ | -------------------------------------------------------------------------- | ------------- |
| Mission            | `intent.mission` in the node's `.cogni/repo-spec.yaml`                     | repo-spec     |
| Orientation (full) | the `<slug>-agent-orientation` hub entry, rendered IN FULL                 | knowledge hub |
| Tooling invariants | `SESSION_BOOTSTRAP_INVARIANTS` constant in the node app                    | code          |
| Skills index       | hub entries of type `skill`/`guide`/`playbook` (use-when framed titles)    | knowledge hub |
| Domain pointers    | `listDomainsFull()` — registered domains + entry counts (empty suppressed) | knowledge hub |

The bundle's stance is **constitution + map**: the code-owned invariants say how every agent must behave; the repo-spec mission says why this node exists; the orientation entry is the current-node map an agent needs to start (where to edit, what not to run, what can break prod/candidate, what to recall next). The git skeleton is deliberately **minimal** — invariants + section frame + recall pointers — and the substance is the Dolt orientation entry, rendered **IN FULL** so the bootstrap _is_ the operating map (no second recall to be useful). Everything else (skills, domains) stays **index-first**: pointers only, never full bodies. The invariants are kept as terse axioms (not paragraphs), and the bundle surfaces the node's derived candidate host (`operator` → `test.cognidao.org`, else `<slug>-test.cognidao.org`) so "validate on candidate" names a concrete URL instead of an env agents must guess.

**Delivery is the instruction-FILE channel, not the hook. The SessionStart hook is a fetch-and-write side-effect, never the injection surface** — because a hook is not a universal inject path across harnesses:

| harness     | model-visible channel                                            | SessionStart hook                                                                   | override                                   |
| ----------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------ |
| Claude Code | output style + `CLAUDE.md`/`AGENTS.md` + `@import`s + Stop check | hook stdout is capped; write cache at start and validate the final response at Stop | **none** (no setting/env raises it)        |
| Codex       | `AGENTS.md`, whole under `project_doc_max_bytes` (32 KiB)        | `additionalContext` default 2500 tokens, spills                                     | `additionalContextLimit = 0` → full inject |
| OpenCode    | root `AGENTS.md` + `opencode.json` instruction files             | no SessionStart injection; workspace setup warms the referenced cache               | n/a                                        |

So the shared loader (`scripts/agent/session-cognition.sh`) **fetches** the node's bundle (URL derived from `.cogni/repo-spec.yaml` `intent.name`: `operator`/`cogni-template` → `https://cognidao.org/api/v1/cognition`, else `https://<slug>.cognidao.org/api/v1/cognition`; falls back to operator) and **writes it to one file**, `.cogni/.cognition-cache.md`. Claude Code ingests that file whole through `CLAUDE.md`/`AGENTS.md` `@import`; its project-scoped `Cogni Contract` output style reinforces the universal no-exceptions response rule in the system-prompt layer on every request, and a deterministic Stop hook rejects a malformed final block, a zero-evidence substantive proposal, or an unapproved Goal/Done-when mutation. These Claude adapters refer to the canonical file contract instead of copying its rich prose. The deterministic check is only a floor: the live-harness eval must also inspect the retrieval trace and cited synthesis, because a correct envelope is not substantive adherence. Codex receives the cache from hook stdout with `additionalContextLimit = 0`. OpenCode does not expand `@` references, so committed `opencode.json` names the same cache in its `instructions` array; per OpenCode's rules contract, that file is combined automatically with root `AGENTS.md`. A failed fetch leaves any warm cache untouched, so a warm workspace survives a hub outage or expired key. Because file instructions resolve at context assembly — before/at hook time — a fresh workspace needs the cache present up front; where a pre-session step exists (`scripts/conductor-worktree-setup.sh`), warm it there. But that step is **Conductor-local only** — hosted operator agents, CI, raw clones, and `claude.ai/code` run no such step, so a cold boot during a hub outage gets nothing from the cache. That is exactly why the **committed invariant skeleton in root `AGENTS.md` is the universal cold-boot floor**: it needs no network and renders the contract's response/state spine regardless of harness, hub, or cache state. Claude's SessionStart hook is write-only to avoid duplicate capped output; Codex's one asymmetry is trust, because its repo-committed hook runs only after one-time `/hooks` approval. See [`cognition-expert`](../../.claude/skills/cognition-expert/SKILL.md) for the full matrix + gotchas.

**The ownership split renders in two tiers so a session always bootstraps — and the rich contract stays refine-in-place.** Do NOT code-own the full contract prose (that reintroduces the two-constitution duplication ONE_VOICE/task.5155 removed, and taxes every wording tweak of the highest-velocity cognition doc with a fleet redeploy). Instead:

- **Terse invariant skeleton** (`SESSION_BOOTSTRAP_INVARIANTS` — ONE-work-item, cite-first, the CICD sequence, Done=behavior, persist, drive-autonomously, plus a one-line "you are bound by the agent-contract; recall + obey it") is **code-owned, committed into the node's own repo, and rendered UNCONDITIONALLY** — never suppressed by a served orientation. Because it is committed, it reaches the agent even when the hub/endpoint is unreachable: it is the **cold-boot floor**.
- **Rich agent-contract prose** (full process + status + communication rules) stays **hub-served and refined in place** via the contribution flow. The hub orientation carries it and **augments** the skeleton; a map-only orientation simply leaves the skeleton as the floor.

This corrects the real `ONE_VOICE` defect (`_bundle.ts:219`): it suppressed the code invariants whenever _any_ orientation was served, so a **map-only** orientation (the common fresh-node case) silently dropped the contract. Rendering the terse skeleton unconditionally fixes that with **no duplication** (the skeleton is axioms, not the prose) and **no refine-in-place regression**. Migration must be intent-atomic: reduce each orientation seed + the operator entry to map-plus-rich-contract (never the terse axioms) in the same change that stops suppressing the skeleton. **Note:** the 2026-10-08 "fresh agents contract-less" outage was a **delivery** failure — a cold cache plus a 401 on the authed endpoint (`SESSION_BOOTSTRAP_INVARIANTS` travels that same door, so moving ownership would not have helped); its fix is the committed skeleton + warm cache below, not contract ownership.

**Node identity: mission seed + agent-orientation entry.** Two artifacts give an agent its bearings, split by mutability:

- **`intent.mission`** in `.cogni/repo-spec.yaml` is the _stable_ one-line north star — why this node exists. It is surfaced as the bundle subtitle. Node formation seeds a refine-me starter (`renderRepoSpec`) so every new node ships with one; the launch agent narrows it.
- **`<slug>-agent-orientation`** (e.g. `operator-agent-orientation`) is the _mutable_ operating map in the knowledge hub — one `guide` entry per node, the current-node context for **every** kind of agent working here (coding, launch, research, governance, validation, operations), not only dev. It answers: what this node is, what agents do here, where authority lives, what actions are safe, what workflows exist, where to edit, what not to run, what can break prod/candidate, and what to recall next. It is a **composite** that cites deeper specs/skills rather than restating them, and cites `cognition-substrate-bootstrap` so the orientation pattern itself compounds in the DAG.

Every node maintains exactly one living orientation entry; agents **refine it in place** (REFINE_OVER_EXTEND) whenever repo layout, scripts, CI, deploy, auth, or validation behavior changes — it is the living map, not a one-time doc. The bundle renders this entry **in full**, preferring the node-specific `<name>-agent-orientation` over the generic starter. Because full-render makes the entry's length the bundle's cost, keep the orientation entry tight and composite (cite deeper specs/skills, don't restate them).

**Fleet distribution is a platform capability, never per-node × per-developer configuration.**
The cognition design has two distribution lanes because its two ownership classes move at
different speeds:

| Change                                                                                                        | Canonical distribution lane                                                                                                                                                                                                                              | Developer experience                                                              |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Mission, orientation, skills, domains, rich agent-contract prose                                              | Write once to that node's Dolt hub; every session refreshes `/api/v1/cognition` into the local cache                                                                                                                                                     | No repo edit; no developer action after initial node registration                 |
| Shared endpoint/composer/loader behavior                                                                      | Curated versioned `@cogni/*` package API, consumed by each node's declared platform cohort                                                                                                                                                               | Arrives with the repo dependency update                                           |
| Harness-native files that must exist before packages or network (`AGENTS.md`, Claude/Codex/OpenCode adapters) | One versioned cognition-bootstrap manifest plus a fail-closed codemod/materializer; new nodes inherit it from `node-template`, existing nodes receive an ordinary reviewed upgrade PR until the operator's dependabot-for-nodes lane automates those PRs | Files are committed in the node repo; cloning or opening a worktree is sufficient |
| Node credential and first cache warm                                                                          | One repo setup command; Conductor invokes it from the workspace bootstrap, other environments invoke the same command                                                                                                                                    | Register once through `/api/v1/agent/register`; never hand-edit harness config    |

`ZERO_PER_DEVELOPER_CONFIG` is the acceptance boundary: a shared cognition change is not
fleet-complete if every node developer must edit Claude/Codex/OpenCode settings, copy a prompt,
or remember an install step. A developer may approve the harness's normal trust prompt and supply
their node credential; all instruction files, hooks, cache wiring, and node URL derivation are
repo-owned and deterministic. `FLEET_VERSION_OBSERVABLE` requires each node's discovery/cognition
surface to expose the installed cognition-bootstrap cohort so the operator can identify drift
without comparing source trees.

Automatic fork-wide source overlay remains forbidden: it destroyed node product paths in
bug.5304. The durable target is a versioned package for shared runtime behavior plus a narrow,
precondition-hashed codemod for the few harness files that intrinsically must live at repo root.
Until the updater exists, one reviewed PR per existing node is known migration debt, not the final
distribution design and not “Done.”

**Node knowledge formation.** A new node's knowledge hub is created empty (Doltgres data is not
copied by forking the repo), so the orientation block ships as a seed: `@cogni/knowledge-base`
base seeds carry a generic `cogni-agent-orientation` starter (`entryType: guide`) inherited by every
node at `seed-doltgres` time. Each node then writes its node-owned durable map as the sibling
`<slug>-agent-orientation` (a re-seed may overwrite the shared starter, so refinement lives in the
slug-specific entry). Operator's own `operator-agent-orientation` cites
`cognition-substrate-bootstrap` so the pattern compounds in the DAG.

**Boundaries.** The bundle is **authed** — any principal (cookie-session human OR `cogni_ag_sk_v1_` agent bearer) gets skill/domain pointers (title, use-when, recall path) plus the current-node orientation entry rendered in full; other entry bodies stay behind the read routes. It sits behind the same gate as the read routes (`KNOWLEDGE_READ_REQUIRES_PRINCIPAL`), so the index does not diverge from the read surface; `GET /api/v1/agent/register` stays the one public bootstrap seam (register → key → cognition). Local/Conductor sessions persist that key in `.env.cogni`; the SessionStart loader reads `.env.cogni` itself and passes `COGNI_API_KEY` (or the current production `COGNI_API_KEY_PROD` during the transition) as the bearer. Root `AGENTS.md` drops to a thin bootstrap pointer at the bundle; node-scoped and subdir `AGENTS.md` files remain (closest-file-wins still holds for code-local rules). This is reversible: revert the PR and `AGENTS.md` carries the full orientation again.

## Current State

In the monorepo today:

- root `packages/*` are cross-node/operator-owned packages;
- `pnpm-workspace.yaml` includes only legacy in-tree node workspaces; submodule-pinned nodes are not parent workspaces;
- `Cogni-DAO/node-template` is the canonical node-at-root template source;
- the operator monorepo may carry `nodes/node-template` only as a gitlink pin for deployment approval;
- `nodes/operator/packages/doltgres-schema` and any remaining legacy in-tree node-local packages are migration surfaces;
- node-template owns its graph and node-local packages in its external repo;
- the active submodule design expects a node-at-root template with `app/`, `graphs/`, `k8s/`, `packages/`, own CI, and own policy.

The proposed product shape is therefore not a greenfield rewrite. It is a naming and ownership cleanup around patterns already present.

### Current package audit

A 2026-06-05 package import audit found that most root packages are genuine shared substrate:

- app-wide platform packages are imported by operator, node-template, and remaining hosted node artifacts: `@cogni/ai-core`, `@cogni/ai-tools`, `@cogni/db-client`, `@cogni/db-schema`, `@cogni/ids`, `@cogni/node-contracts`, `@cogni/node-core`, `@cogni/node-shared`, `@cogni/node-streams`, `@cogni/node-ui-kit`, `@cogni/scheduler-core`, `@cogni/work-items`;
- graph substrate is shared: `@cogni/langgraph-graphs`, `@cogni/graph-execution-core`, `@cogni/graph-execution-host`;
- knowledge substrate is shared: `@cogni/knowledge-base` is imported by node-local Doltgres schema packages, and `@cogni/knowledge-store` is imported by apps and Doltgres packages;
- some root packages are operator-plane utilities rather than node-product packages: `@cogni/dns-ops` and attribution pipeline packages;
- `@cogni/temporal-workflows` currently mixes reusable scheduled-graph mechanics with operator governance/ledger workflows. Split the reusable node runtime into the published node-template package; keep operator workflows operator-owned.

So the first migration should not be a broad carve-out from root `packages/`. Moving shared substrate into a node would make the template look cleaner but would damage the current dependency truth.

## Playbook

Use this playbook when deciding whether to move or create a package.

### Step 1 - Classify the package

| Question                                                                  | Destination                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Imported by two or more node apps/graphs/packages?                        | root `packages/<name>`                                                          |
| Imported only by one node repo's `app`, `packages`, or graph definitions? | node repo `packages/<name>`                                                     |
| Imported only by operator-plane code or root services?                    | root `packages/<name>` unless it is strictly `nodes/operator/app` product logic |
| Has process lifecycle, health checks, env loading, or worker loop?        | `services/<name>` or `app/`, not `packages/`                                    |
| Is a DB schema package with node-local tables?                            | node repo `packages/postgres` or `packages/doltgres`                            |

### Step 2 - Check real consumers

Run both package-declaration and import checks. Stale `package.json` dependencies are common enough that declarations alone are not authoritative.

```bash
rg -n '"@cogni/<name>"|from "@cogni/<name>"|from "@cogni/<name>/' \
  nodes packages services tests scripts \
  -g 'package.json' -g '*.{ts,tsx,js,mjs}'
```

Then classify only code importers under:

```text
nodes/<node>/app
nodes/<node>/graphs
nodes/<node>/packages/*
```

as node-product consumers. Root `packages`, `services`, `scripts`, CI, and operator provisioning are operator-plane or shared-substrate consumers.

### Step 3 - Move one package at a time

For a node-owned package move:

1. move the directory into `packages/<bare-name>` in the node-at-root repo, or `nodes/<node>/packages/<bare-name>` in the monorepo;
2. rename the package to `@cogni/<node>-<bare-name>`;
3. update import names and package declarations;
4. update `tsconfig` project references and package build validation;
5. run `pnpm packages:build` plus the package's targeted typecheck/tests;
6. avoid compatibility shims unless an actual external consumer is blocked.

For node-template projection work, prefer changing the projected node-at-root repo first. Inline monorepo nodes can keep their old shape until the projection proves the model.

## Pareto Package Priority

The highest-value moves, based on the current package layout, are:

| Priority | Move                                                                                           | Why                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1        | Add node-template `packages/workflows` + private `services/workflow-worker`                    | Makes graphs and durable orchestration node-owned from birth; uses the existing multi-service artifact bundle. |
| 2        | Publish `@cogni-dao/agent-workflow-runtime` from node-template                                 | Gives nodes one pinned bootstrap/runtime contract without fork-copied plumbing.                                |
| 3        | Keep node graph packages node-at-root and pair them with the workflow catalog                  | Makes the node repo read as one product: graphs reason, workflows coordinate.                                  |
| 4        | node-at-root `packages/doltgres-schema` → `packages/doltgres`                                  | Names the knowledge plane by capability instead of implementation detail.                                      |
| 5        | Add node-at-root `.cogni/node.yaml`; add `packages/postgres` only with a real node-local table | Keeps substrate declaration compact and avoids empty scaffolding.                                              |

Packages that should **not** move in the MVP: `@cogni/db-client`, `@cogni/db-schema`, `@cogni/knowledge-base`, `@cogni/knowledge-store`, `@cogni/langgraph-graphs`, `@cogni/graph-execution-core`, `@cogni/graph-execution-host`, `@cogni/node-contracts`, `@cogni/node-core`, `@cogni/node-shared`, `@cogni/node-ui-kit`. They are shared substrate today. The MVP also does not move graph execution into the Worker: it calls the app's private graph-run API so billing, run persistence, and telemetry keep one execution path.

The new runtime package is intentionally additive. Node code continues to import and program
against pinned `@langchain/langgraph` and `@temporalio/*` SDKs directly; Cogni owns the deployment
and operational contract, not a proprietary graph or Workflow abstraction.

## MVP

The MVP should not reorganize every package. It should make newly minted node repos feel coherent while preserving current deployment progress.

### M0 - Document and freeze the product shape

Land this spec and link it from the CI/CD contract. Treat it as the target shape for future node-at-root work.

No code moves.

### M1 - Normalize the node-at-root template package layout

In the node-template repo projection, prefer:

```text
packages/graphs
packages/doltgres
```

over:

```text
graphs
packages/doltgres-schema
```

Only do this in the node-at-root template lane, not as a drive-by across inline monorepo nodes. The monorepo can keep `nodes/<node>/graphs` temporarily because the CI/CD contract already names `graphs/` as carried content.

Acceptance:

- the generated node repo has a simple `packages/*` library layer;
- app imports use workspace names;
- local `pnpm packages:build` or equivalent builds the graph and Doltgres package;
- no operator build target treats the node package as root operator content.

### M2 - Rename Doltgres package by capability, not implementation detail

Move from `doltgres-schema` to `doltgres` in the node-at-root template.

Keep exports explicit:

```text
@cogni/<node>-doltgres
@cogni/<node>-doltgres/knowledge
@cogni/<node>-doltgres/work-items
```

If the migration blast radius is high, keep `doltgres-schema` in inline nodes and make the new name part of the projected template only. Do not add a compatibility shim unless a real consumer requires it.

### M3 - Add `packages/postgres` only when the template has a local table

Do not scaffold an empty Postgres package. The current database contract says node-local Postgres schema packages are created on first node-local table.

When needed, use:

```text
packages/postgres
```

with exports:

```text
@cogni/<node>-postgres
@cogni/<node>-postgres/schema
@cogni/<node>-postgres/client
```

The package must not read env. Runtime code passes DSNs or DB clients from `app/`.

### M4 - Add one node manifest for substrate declarations

Introduce `.cogni/node.yaml` as the node's compact substrate declaration:

```yaml
postgres:
  enabled: true
doltgres:
  enabled: true
graphs:
  package: "@cogni/<node>-graphs"
storage:
  enabled: false
streams:
  enabled: false
```

This should be declarative only. The operator can later consume it during publish/provisioning, but the MVP value is making the node's expected substrates visible to agents and humans.

### M5 - One-command local substrate

Add a node-local command equivalent to Supabase local dev:

```bash
pnpm dev:stack
```

It should start the app plus the minimum local substrates for that node: Postgres, Doltgres when enabled, Redis only if streams are enabled, and any local mock services required by the template.

This is the product MVP. A new node dev should clone the node repo, run one setup command, and see the node operate against local managed substrates.

## Placement vs Provisioning

A node has two independent axes. Conflating them is the single most expensive mistake made against this
architecture to date, so they are stated separately:

| axis             | owner              | declared in                                             | answers                                                                |
| ---------------- | ------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Provisioning** | operator substrate | the secrets catalog + node registry                     | does this node exist, and does it have its DB, secrets and identity?   |
| **Placement**    | operator catalog   | `infra/catalog/<node>.yaml` `deployment_provider.<env>` | where does its app process run — our k3s, or external compute (Akash)? |

**Every node is provisioned identically. Placement selects only which deployment steps run.** A node
moved to external compute still needs exactly the same DB role, the same OpenBao path, the same
ExternalSecret and the same identity it needed before; nothing about _where the process runs_ changes
_who the node is_.

The corollary is the part that bites: **a placement change is also a provisioning change** whenever the
target substrate needs a different credential shape. External compute cannot receive fleet-shared
credentials — they would be handed to a rented third-party host — so it consumes node-scoped equivalents
instead. Those equivalents are ordinary catalog entries and must be declared before anything consumes
them. See `docs/spec/secrets-management.md` invariants 17 (`PLACEMENT_DOES_NOT_GATE_PROVISIONING`) and 18
(`PROVIDER_SECRET_DELTAS_ARE_DECLARED_NOT_RENAMED`).

Practical rule for reviewers: if a change makes a node's provisioning conditional on its provider — a
job matrixed over "the k3s nodes", a step gated on `provider == k3s` that creates state rather than
deploying it — that is the bug. Branch the _steps_, never the _population_.

## Decision Rules

1. Root `packages/*` in the operator monorepo are cross-node packages.
2. Node-at-root `packages/*` are node-owned packages.
3. Schema plus typed client can live in the same node-owned DB package, but env loading cannot.
4. Postgres and Doltgres stay in separate packages because they are separate planes.
5. Graph definitions should be a package; graph process lifecycle, if any, should be a service.
6. Empty packages are avoided unless they are part of the template's first-run experience.
7. The operator never builds node code for a submodule node; it consumes the node's image and metadata.
8. Routine node evolution should be a node PR: Postgres schema, Doltgres schema, graph definitions, contracts, secret declarations, storage/stream declarations, and base runtime shape.
