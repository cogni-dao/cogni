---
id: agentic-fork-bootstrap-spec
type: spec
title: Agentic Fork Bootstrap — Minimum Human Root, Agent Does the Rest
status: draft
spec_state: draft
trust: draft
summary: Defines the credential floor a human must supply to take a freshly-forked node-template to a green production deployment. An AI setup agent generates, sets, and rotates every other secret and provisions every other artifact. Bridge between today's ~30-secret manual `SETUP_DESIGN.md` flow and the zero-touch `node-launch.md` future.
read_when: Designing fork onboarding, scoping agent-provisioning permissions, evaluating an Operator GitHub-Admin-App roadmap, or auditing whether a new credential added to `REQUIRED_SECRETS` could have been generated instead of asked for.
owner: derekg1729
created: 2026-05-17
tags: [infra, onboarding, agent-provisioning, secrets, roadmap]
---

# Agentic Fork Bootstrap

## Context

Today a fork owner provides ~30 secrets across two surfaces (`.env.local` + GitHub
environment secrets), interleaves browser steps with CLI steps, and reads three
docs that drift from each other:

- [`scripts/setup/SETUP_DESIGN.md`](../../scripts/setup/SETUP_DESIGN.md) — canonical secret list
- [`docs/runbooks/INFRASTRUCTURE_SETUP.md`](../runbooks/INFRASTRUCTURE_SETUP.md) — VM provisioning runbook
- [`.claude/skills/node-setup/SKILL.md`](../../.claude/skills/node-setup/SKILL.md) — agent orchestration

Drift is structural: every new service added to runtime grows all three docs and
the `REQUIRED_SECRETS` array in `scripts/ci/deploy-infra.sh`. The human input
surface has been allowed to grow with the runtime surface. **It shouldn't.**

The conflation: docs treat "credential the human must mint in a browser" and
"credential the deployed pod consumes" as the same thing. They're different
threat models and different provisioning paths.

## Goal

**The human provides only credentials that can't be minted by an API. The agent generates, sets, rotates, and verifies everything else.**

Two consequences:

1. The `.env.bootstrap` the human fills should fit on one screen.
2. Adding a new pod-runtime secret never adds a human-input field — only an
   agent-side generation step.

## Non-Goals

- **Not zero-touch.** A human still mints 5 tokens in 5 browser tabs. Full
  zero-touch is [`node-launch.md`](node-launch.md); this spec is the bridge.
- **Not a secrets manager.** v1 doesn't rotate, vault, or HSM-back anything.
  `.env.bootstrap` is plaintext on the human's laptop. Proper secret
  management is vNext.
- **Not multi-env in one pass.** v1 ships one environment per invocation.
- **Not DAO formation or payment activation.** Phase 0 + Phase 3 require
  browser wallet signing; out of scope. Fork boots `payments.status: pending`.
- **Not a replacement for `setup-secrets.ts`.** That tool handles interactive
  secret management for already-deployed forks; bootstrap is the first-time path.

## Design

The remainder of this spec is the design: the 5-service credential floor,
the sequential bootstrap topology, the `.env.bootstrap` shape, the GitHub
Admin role prerequisite, the Grafana stack ownership decision, the v1
implementation gaps, the roadmap, and the invariants.

### Fork Identity — three layers, one new file

The canary in §Canary Lessons (`work/handoffs/bootstrap-v0-canary.md`, dev's
HARDSHIPS.md) hit two architectural blockers (B1: hardcoded upstream push
URL; B2: hardcoded poly/resy DNS + DB names) because **fork identity was
spread across script literals**, not one declarative source.

After this PR, identity has three clean layers, each with one source of
truth:

| Layer    | SSOT                                   | Used for                                                              |
| -------- | -------------------------------------- | --------------------------------------------------------------------- |
| **Repo** | `git remote get-url origin` (implicit) | `COGNI_REPO_URL`, push targets, GH API repo arg                       |
| **Fork** | **`infra/fork.yaml`** (new)            | `domain.root` (Cloudflare zone) — composes all FQDNs                  |
| **Node** | `infra/catalog/<node>.yaml` (existing) | `NODE_TARGETS`, per-env subdomain prefix, image tags, deploy branches |

`infra/fork.yaml` declares one field:

```yaml
schema_version: 1
domain:
  root: cognidao.org # Cloudflare zone you own
```

Forking changes that one value. Every URL re-derives. No script literal
references the zone name; no `for node in operator poly resy` lives in
provisioning code. The agent walks the catalog and the fork-spec.

Composition rule: `public_url_for_target(env, node)` reads
`infra/catalog/<node>.yaml::public_url.<env>` (the **subdomain prefix**;
empty string = root domain) and composes with `infra/fork.yaml::domain.root`
as `https://<prefix>.<root>` (or `https://<root>` if prefix is empty).

## V1 Credential Floor — 5 Services, 8 Lines

| #   | Service       | Authority shape           | What it mints downstream                                                                                                    | Pure passthrough? |
| --- | ------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 1   | Cherry        | Account API token         | VMs + SSH keys (account-scoped)                                                                                             | No                |
| 2   | Cloudflare    | Zone API token (scoped)   | DNS records for fork's domain                                                                                               | No                |
| 3   | GitHub        | **Repo-Admin** PAT or App | GitHub environment + every secret in [`REQUIRED_SECRETS`](../../scripts/ci/deploy-infra.sh) + deploy branches + protections | No                |
| 4   | Grafana Cloud | Stack-admin API token     | Service accounts + data sources + dashboards **within a pre-existing stack** (see §Grafana Stack Ownership)                 | No                |
| 5   | OpenRouter    | Plain account key         | (nothing — passes through to LiteLLM in the pod)                                                                            | **Yes**           |

Four mint downstream credentials. One is pass-through. That asymmetry is real
and intentional in v1 — OpenRouter has no admin-API shape we can use, and the
key is account-level (see §`.env.bootstrap` Handling & Lifecycle for the implication).

### `.env.bootstrap` shape

```bash
# === Control plane (minting authority) ===
CHERRY_AUTH_TOKEN=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ZONE_ID=            # public ID, but operator input
GITHUB_ADMIN_PAT=              # bot user MUST be repo Admin (see §GitHub Admin Role)
GITHUB_ADMIN_USERNAME=
GRAFANA_CLOUD_ADMIN_TOKEN=     # Stack-admin role, NOT Editor
GRAFANA_CLOUD_STACK_SLUG=      # which Grafana stack to provision into

# === Runtime passthrough ===
OPENROUTER_API_KEY=
```

Eight lines. Five secrets. Two non-secret operator inputs (zone ID + stack slug)
that belong in the same file because they're operator decisions.

## What V1 Defers (And Why That's OK)

| Deferred                                                                        | Why                                                                 | When it lands                                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| Alchemy `EVM_RPC_URL`, `POLYGON_RPC_URL`                                        | Only used by on-chain reads for operator-wallet + poly node         | Wired post-deploy when fork activates Phase 3                 |
| DAO formation (Phase 0)                                                         | Browser wallet sign at `cognidao.org/setup/dao` — irreducibly human | Pre-bootstrap step the human does once; not in agent scope    |
| Split contract deploy (Phase 3)                                                 | Browser wallet sign on Base                                         | Removable only by routing through Privy server-wallet (vNext) |
| All OAuth providers, Privy, Tavily, Discord, PostHog, SonarCloud, WalletConnect | Optional — app boots without them; agent leaves them unset          | Agent prompts only when a feature requiring them is enabled   |

Critically: `/readyz` returns 200 without any deferred credential. The deferred
list is "features off by default," not "broken deployment."

## Bootstrap Topology

Provisioning is **sequential, not parallel**. Each step's output is the next
step's input.

```
human gives 5 tokens
        │
        ▼
┌─────────────────────────────────────────┐
│ Agent reads .env.bootstrap (one paste)  │
└─────────────────────────────────────────┘
        │
        ▼
[STEP A]  #1 Cherry  ──→ tofu apply
                          ├─ outputs:  VM_HOST (IP), SSH key pair
                          └─ agent gens: SOPS age key (decrypts SOPS-encrypted
                                          secrets in the deploy branch at
                                          Argo CD sync time on the VM)
        │
        ▼
[STEP B]  #2 Cloudflare ──→ DNS A records (needs VM_HOST from A)
                          ├─ <user-fqdn>          → VM_HOST
                          └─ <env>.vm.<zone>      → VM_HOST    (bug.0295)
        │
        ▼
[STEP C]  #4 Grafana (Stack-admin) ──→ within pre-existing stack
                          ├─ create service account → Loki write token
                          ├─ create service account → Prometheus R/W tokens
                          └─ provision Postgres data source for VM_HOST
                          (needs VM_HOST from A; mints tokens consumed in D)
        │
        ▼
[STEP D]  #3 GitHub Admin PAT ──→ collates everything above
                          ├─ PUT /environments/{env}
                          ├─ PUT /actions/secrets/* — values sourced from:
                          │    • openssl rand:  DB passwords, AUTH_SECRET,
                          │                     LITELLM_MASTER_KEY,
                          │                     SCHEDULER_API_TOKEN,
                          │                     BILLING_INGEST_TOKEN,
                          │                     INTERNAL_OPS_TOKEN,
                          │                     OPENCLAW_GATEWAY_TOKEN
                          │    • Step A:       SSH_DEPLOY_KEY, SOPS age key,
                          │                     VM_HOST
                          │    • Step C:       GRAFANA_CLOUD_LOKI_*,
                          │                     PROMETHEUS_*
                          │    • #5:           OPENROUTER_API_KEY (passthrough)
                          │    • operator:     DOMAIN (from #2 zone + slug)
                          ├─ create deploy/preview-<node> branches
                          └─ dispatch promote-and-deploy.yml
        │
        ▼
        green deploy + /readyz 200
```

**Ordering invariant:** A → B and A → C in parallel → D. Step D cannot begin
until A and C complete; B can run anytime after A. **Step #5 (OpenRouter) is
not a step** — its value is read once during D's collation.

Authoritative list of values D sets: [`REQUIRED_SECRETS`](../../scripts/ci/deploy-infra.sh)

- [`OPTIONAL_SECRETS`](../../scripts/ci/deploy-infra.sh). When that array
  changes, D's source-mapping changes; this diagram does not need to enumerate
  every entry.

## Grafana Stack Ownership

V1 assumption: **the human pre-creates one Grafana Cloud stack at signup**
(every Grafana Cloud account auto-provisions a default stack on first login).
The agent provisions _within_ that stack — service accounts, data sources,
dashboards — using a Stack-admin token scoped to that single stack.

The agent does **not** create the stack itself. Reasons:

- Stack creation requires an **org-level Cloud Access Policy token** (`glc_`
  prefix), which is a strictly higher authority than the stack-admin token
  (`glsa_` prefix) the agent uses. Asking for it would re-inflate the
  human-input surface.
- A stack is also a billing boundary. Letting an agent mint stacks at will
  has cost-attribution implications the spec isn't ready to own.

`GRAFANA_CLOUD_STACK_SLUG` is therefore an operator decision the human passes
in, not a value the agent generates. Validate at ingest by calling
`GET /api/v1/stacks/<slug>` with the admin token.

vNext (operator-hosted Grafana org) inverts this: operator owns the stack,
agent mints per-fork service accounts within it, fork owner provides no
Grafana credential at all.

## `.env.bootstrap` Handling & Lifecycle (v1)

Treat it like any other dev-local credentials file: gitignored, `chmod 600`,
delete (or keep, your call) after bootstrap. Re-running bootstrap with the
same file is idempotent — agent re-PUTs only changed secrets.

**Rotation, destroy, age-key re-encryption: manual in v1.** Re-paste a new
value into `.env.bootstrap` and re-run bootstrap; for destroy, run
`tofu destroy` and clean up GitHub env + Grafana service account by hand.
Lifecycle automation is vNext — tracked as Open Q5.

**One pass-through to flag:** `OPENROUTER_API_KEY` is account-level. A
pod-runtime compromise leaks the human's full OpenRouter authority across
every fork using that key. Open Q1 (per-fork sub-account) exists for this
reason; no v1 mitigation.

## Agent Rules (from canary lessons)

The v0 canary surfaced four rules the orchestrating agent must follow.
Each maps to an actual mis-step or near-miss; they're in the spec so any
future driving agent reading this cold inherits the lesson.

**A1 — Never accept secrets via chat.** The v0 agent asked the operator
to "paste your PAT in the next message" when confused about where to put
it. That would have leaked 5 minting-authority credentials into the
conversation transcript. The answer to "where do I paste?" is always
"into the gitignored file you already have open." Bootstrap reads from
the file and only the file.

**A2 — Bot identity = the PAT, not the gh keychain.** Do not run
`gh auth login` for a bot account when you have its PAT. `GH_TOKEN=<pat>
gh ...` is the entire point of the PAT. Bootstrap exports `GH_TOKEN`
from `GITHUB_ADMIN_PAT` and that's sufficient for every `gh api` and
`gh secret set` call.

**A3 — Username must match the PAT login.** GitHub disallows underscores
in usernames; the canary mis-typed `i_am_coco` instead of `i-am-coco` and
the admin-role check returned a misleading 404. Bootstrap validates
`GITHUB_ADMIN_USERNAME == gh api user --jq .login` before any side effect.

**A4 — Pre-existing same-named non-fork repos force a renamed fork.**
The bot account had a `node-template` repo unrelated to the upstream;
`gh repo fork --clone` would have silently produced `node-template-1`
(suffix). The quickstart prompt mandates explicit detection (`gh api
repos/$USER/<name>` + `.parent.full_name` inspection) and a defaulted
alternate name (`cogni-node-$(date +%Y%m%d)`) instead of accepting the
suffix.

**A5 — Never delete account-scoped infra without enumerating ALL
references across ALL projects.** A v0 canary recovery attempt deleted a
Cherry SSH key that looked orphaned in its project but was load-bearing
for a VM in a sibling project on the same Cherry account. **Cherry SSH
keys are account-scoped, not project-scoped.** Same applies to any
account-scoped resource (DNS zones, Cloudflare API tokens, GitHub
organization secrets). Before deletion: enumerate every consumer across
every project on the account, dump each consumer's references, confirm
none touch the target. "Project X has zero references" is _necessary
but not sufficient_. Code-side belt-and-suspenders: this PR also
namespaces SSH-key labels per-fork (`<gh-repo-slug>-<env>-deploy`) so
the collision class doesn't recur.

**A6 — When a script's own idempotency assumption fails, STOP and ask.**
The canary's `tofu apply` expected to create a Cherry SSH key that
already existed; the agent's instinct was to delete the conflict and
retry. **That's the wrong instinct.** If the resource lives outside the
directory tree of the current run (Cherry account, Cloudflare zone,
GitHub org), the conflicting resource probably belongs to someone or
something else — deleting it can take down production. Correct move:
abort, surface the conflict to the operator, let them decide whether
to delete or to rename the inbound resource. The script's idempotency
contract is _for resources the script owns_; cross-system collisions
are out-of-contract.

## GitHub Admin Role — The Non-Obvious Prerequisite

Scope alone is insufficient. To mint env-scoped secrets via API, the PAT user
must hold the **Admin** repository role:

- `PUT /repos/{owner}/{repo}/environments/{env}` → requires Admin
- `PUT /repos/{owner}/{repo}/actions/secrets/{name}` → requires Admin
- `PUT /repos/{owner}/{repo}/environments/{env}/secrets/{name}` → requires Admin

A bot account with Maintain role and a Classic PAT carrying every scope in the
list **will still 403**. The bot must be added as Admin collaborator (or be the
org owner).

### Classic PAT scopes

`repo`, `workflow`, `admin:repo_hook` — and bot user must hold Admin role.

### Fine-grained PAT alternative (preferred)

Single-repo scope. Permissions: `Administration: Write`, `Environments: Write`,
`Secrets: Write`, `Actions: Write`, `Contents: Write`, `Pull requests: Write`,
`Workflows: Write`. 90-day max lifetime — accept that v1 requires manual rotation.

### Validating Admin role at ingest (not at first 403)

```bash
gh api "repos/${OWNER}/${REPO}/collaborators/${GITHUB_ADMIN_USERNAME}/permission" \
  | jq -r '.permission' \
  | grep -qx admin || { echo "ERROR: bot lacks Admin role"; exit 2; }
```

Agent runs this immediately after reading `.env.bootstrap`. Failure here aborts
bootstrap before any side effect — no half-provisioned VMs, no orphaned DNS
records.

## Roadmap

### v1 (this spec) — 5 human tokens, agent does the rest

Implementation entry point: [`scripts/setup/bootstrap.sh`](../../scripts/setup/bootstrap.sh)
(invoked via `pnpm bootstrap`). Procedure docs:
[`scripts/setup/SETUP_DESIGN.md`](../../scripts/setup/SETUP_DESIGN.md),
[`.claude/skills/node-setup/SKILL.md`](../../.claude/skills/node-setup/SKILL.md).

This spec is the design intent; those docs are the procedure.

**Explicit v1 implementation gaps** (open work items, not design retreats):

- **Grafana slot is pass-through in v1, not minting.** The script accepts
  pre-minted `GRAFANA_CLOUD_LOKI_*` + `PROMETHEUS_*` env values if the human
  pastes them; if absent, observability is skipped. The §V1 Credential Floor
  table still names Grafana as a minting authority because that's the
  north star — wire-up of the stack-admin API call is roadmap.
- **One environment per run.** v1 ships `candidate-a` only. Preview and
  production land by re-running the script with `--env preview` /
  `--env production` after candidate-a deploys green. Multi-env single-pass
  is roadmap.
- **DAO formation + Split-contract deploy stay out of scope.** The deployed
  fork boots with `payments.status: pending`. Activation is a separate
  ~10-min browser session done after green deploy.

### vNext — Operator GitHub Admin App

Replace slot #3 (`GITHUB_ADMIN_PAT`) with a GitHub App installation:

- **Operator hosts one App** with the same permission surface as the v1
  fine-grained PAT (Administration:W, Environments:W, Secrets:W, Actions:W,
  Contents:W, PRs:W, Workflows:W).
- **Fork owner installs the App** on their fork repo (one-click consent screen).
- **Agent fetches a JWT-derived installation token at need-time** (1-hour TTL).

Removes the long-lived bot PAT from `.env.bootstrap`. Permissions become visible
in the App config instead of folded into a Classic-PAT scope bag. Audit trail
becomes per-install, not per-bot-user.

Same shape works for Grafana — operator runs a multi-tenant Grafana org and
mints scoped service accounts per fork install. Cherry stays a per-fork token
until vNext-vNext (Cherry has no app-installation primitive).

### vNext-vNext — Zero-touch from operator site

Aligns with [`docs/spec/node-launch.md`](node-launch.md). Founder clicks
"Launch Node" on `cognidao.org`; operator-side workflow provisions a
shared-cluster namespace (Akash or shared k3s), repo, config, and live deploy
in a single async flow. The 5 v1 tokens become 0 — operator holds all minting
authority, founder holds only a signed consent.

## Pointers

| Doc                                                                                                           | Role                                                |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [`scripts/setup/SETUP_DESIGN.md`](../../scripts/setup/SETUP_DESIGN.md)                                        | Today's canonical secret list (the ~30)             |
| [`.claude/skills/node-setup/SKILL.md`](../../.claude/skills/node-setup/SKILL.md)                              | Agent orchestration loop (Phases 0–7)               |
| [`docs/runbooks/INFRASTRUCTURE_SETUP.md`](../runbooks/INFRASTRUCTURE_SETUP.md)                                | VM provisioning runbook (Cherry + SSH + tofu)       |
| [`.claude/skills/dns-ops/SKILL.md`](../../.claude/skills/dns-ops/SKILL.md)                                    | Cloudflare DNS automation (slot #2)                 |
| [`scripts/ci/deploy-infra.sh`](../../scripts/ci/deploy-infra.sh)                                              | `REQUIRED_SECRETS` array — the deploy-side env gate |
| [`nodes/<node>/app/src/shared/env/server-env.ts`](../../nodes/node-template/app/src/shared/env/server-env.ts) | App boot env schema (Zod)                           |
| [`docs/spec/node-launch.md`](node-launch.md)                                                                  | vNext-vNext zero-touch target                       |

## Invariants

- **HUMAN_INPUT_BOUNDED.** New runtime credentials never add a human-input field
  in `.env.bootstrap`. They are either generated by the agent or fetched from
  one of the 5 minting authorities. _(Enforcement: review-gate. Reviewers reject
  PRs that add a field to `.env.bootstrap` without a §V1 Credential Floor edit.)_
- **AGENT_GENERATES_BY_DEFAULT.** Any new field added to `REQUIRED_SECRETS`
  must be either (a) generatable by `openssl rand` / `ssh-keygen` / `age-keygen`,
  (b) derivable from a v1 minting authority, or (c) raise an exception in this
  spec with explicit justification. _(Enforcement: review-gate, same as above.)_
- **REPO_ADMIN_ROLE_REQUIRED.** GitHub PAT/App must hold Admin on the target
  repo. This is a role, not a scope. _(Enforcement: agent-side `gh api
collaborators/{user}/permission` check at ingest — see §Validating Admin
  role.)_
- **NO_DRIFT_BETWEEN_DOC_AND_GATE.** `REQUIRED_SECRETS` in `deploy-infra.sh` is
  the source of truth for deploy-side env. `SETUP_DESIGN.md`'s list and any
  count in this spec must derive from it, not parallel it.
  **⚠️ Enforcement aspirational in v1.** A `scripts/ci/check-secret-list-coherence.sh`
  validator that diffs `REQUIRED_SECRETS` against `SETUP_DESIGN.md`'s table
  and `server-env.ts`'s required Zod fields, wired into `pnpm check`, is a
  follow-up task. Until it exists, this invariant ages with the docs it
  claims to govern — flagged as Open Question #4.

## Open Questions

1. Should `OPENROUTER_API_KEY` graduate to vNext as "operator mints sub-account
   per fork" once OpenRouter exposes a sub-account API? Real urgency — see
   §`.env.bootstrap` Handling & Lifecycle: this is the highest-blast-radius pass-through in v1.
2. Cherry has no App-installation primitive. Stay per-fork-token, migrate to
   Hetzner/Vultr/Linode (which do have token-bootstrap APIs), or wait for
   Akash via `node-launch.md`?
3. Where does payment activation (Phase 0 + 3, both browser-wallet-signed) live
   in the roadmap? Today: out of scope. vNext candidate: Privy server-wallet
   signs Split deploy on the founder's behalf, gated by a one-time consent.
4. **NO_DRIFT enforcement.** When is `scripts/ci/check-secret-list-coherence.sh`
   written and wired into `pnpm check`? Until then, the invariant is a
   reviewer-only check.
5. **`bootstrap:destroy` script.** §Lifecycle promises one but doesn't deliver
   one. Tracked separately.
