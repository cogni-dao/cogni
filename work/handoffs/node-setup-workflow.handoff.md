---
id: node-setup-workflow.handoff
type: handoff
work_item_id: task.0233
status: active
created: 2026-04-02
updated: 2026-04-02
branch: integration/multi-node
last_commit: 4851e7e7e
---

# Handoff: Node Setup Workflow — DAO Wizard → Operator AI → Provisioning

## Context

- External users request a new Cogni node (a sovereign DAO + app). Today this is 7+ manual steps. The goal is: user fills a form, operator AI handles the rest with 1-2 human checkpoints.
- The DAO formation wizard exists at `/setup/dao` in the operator app — it creates on-chain governance (2 wallet txs) and outputs a repo-spec fragment. Currently a static page with no downstream automation.
- Multi-node infrastructure is built: per-node databases, per-node auth, per-node billing routing, per-node repo-spec identity. All proven on `integration/multi-node`.
- The missing piece: connecting the wizard output to automated node provisioning (branch from template, wire env, create DNS, PR for review).

## Current State

- **Working:** DAO formation wizard (`/setup/dao`) — 3-field form, 2 wallet txs, server verification, repo-spec YAML output
- **Working:** `nodes/node-template/` — forkable base with full platform (app + graphs + `.cogni/repo-spec.yaml`)
- **Working:** Per-node infra — DB provisioning (`COGNI_NODE_DBS`), auth isolation (`AUTH_SECRET_{NODE}`), billing routing (`CogniNodeRouter` in LiteLLM)
- **Working:** Operator repo-spec `nodes[]` registry — declares all nodes with UUID, name, path, endpoint
- **Not built:** Automation from wizard output → node creation (branching, wiring, DNS, PR)
- **Not built:** Operator AI agent that receives the ticket and executes the workflow
- **Known blocker:** `TOOL_BINDING_REQUIRED` — shared tool catalog crashes node apps when operator adds tools nodes don't bind. Tracked in task.0248.

## Decisions Made

- Per-node identity via repo-spec UUIDs, not env var slugs — [task.0257](../items/task.0257.node-identity-via-repo-spec.md), [PR #690](https://github.com/Cogni-DAO/cogni/pull/690)
- DB-per-node, not tenancy columns — [multi-node-tenancy spec](../../docs/spec/multi-node-tenancy.md)
- Shared identity provider, per-node sessions — [multi-node-tenancy spec §Auth](../../docs/spec/multi-node-tenancy.md#auth-model)
- Node formation outputs repo-spec YAML — [node-formation spec](../../docs/spec/node-formation.md)
- Operator repo-spec is the node registry — [`.cogni/repo-spec.yaml` nodes[]](../../.cogni/repo-spec.yaml)

## Next Actions

- [ ] **Design the agent workflow:** User submits DAO wizard → operator AI receives ticket → executes provisioning steps → creates PR → human reviews
- [ ] **Wire wizard output to ticket:** `/setup/dao` verify endpoint currently returns repo-spec YAML. It should also create an internal work item or trigger for the operator AI.
- [ ] **Automate technical wiring (the agent's checklist):**
  1. Generate `node_id` UUID (or use the one from DAO formation)
  2. Derive `scope_id` via `uuidv5(node_id, "default")`
  3. Create `nodes/{name}/.cogni/repo-spec.yaml` — paste DAO formation output + add `scope_id`, `scope_key`, `governance.chain_id`
  4. Add entry to operator `.cogni/repo-spec.yaml` `nodes[]` — `node_id`, `node_name`, `path`, `endpoint`
  5. Copy `nodes/node-template/` → `nodes/{name}/`
  6. Add to `.env.local`: `DATABASE_URL_{NAME}`, `DATABASE_SERVICE_URL_{NAME}`, `AUTH_SECRET_{NAME}`
  7. Add UUID to `COGNI_NODE_ENDPOINTS` env
  8. Add DB name to `COGNI_NODE_DBS`
  9. Add `dev:{name}` script to `package.json` with `COGNI_REPO_PATH=$(pwd)/nodes/{name}`
  10. Run `pnpm db:provision:nodes && pnpm db:migrate:nodes`
  11. DNS: create `{name}.cognidao.org` subdomain via `@cogni/dns-ops`
- [ ] **Define human checkpoints:** Which steps need human approval before proceeding? (likely: PR review, DNS creation)
- [ ] **Style customization:** Node branding (icon, colors, name) per `docs/guides/new-node-styling.md`

## Risks / Gotchas

- `TOOL_BINDING_REQUIRED` drift: adding tools to operator crashes node apps until they bind the same tools. task.0248 (platform extraction) fixes this. Until then, new nodes must copy all tool bindings from operator.
- `COGNI_REPO_ROOT` validation accepts `package.json` OR `.cogni/repo-spec.yaml` OR `.git` — node dirs only have repo-spec. Don't tighten this validation.
- `COGNI_NODE_ENDPOINTS` is manually synced with operator repo-spec `nodes[]`. Future: auto-generate from repo-spec at startup.
- DAO formation wizard currently requires wallet signature in browser. The operator AI can't sign — human must complete DAO formation first, then hand the repo-spec fragment to the agent.
- Nodes will eventually graduate to standalone repos (roadmap item in proj.operator-plane). Design the workflow so it doesn't assume monorepo forever.

## Pointers

| File / Resource                                            | Why it matters                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `docs/spec/node-formation.md`                              | Full DAO formation lifecycle (2 wallet txs → server verify → repo-spec output) |
| `docs/spec/node-launch.md`                                 | Zero-touch provisioning design (Temporal workflow, 8 steps)                    |
| `docs/spec/multi-node-tenancy.md`                          | Auth, data isolation, metering boundaries (11 invariants)                      |
| `docs/spec/node-operator-contract.md`                      | Sovereignty invariants (FORK_FREEDOM, DATA_SOVEREIGNTY)                        |
| `.cogni/repo-spec.yaml`                                    | Operator repo-spec with `nodes[]` registry                                     |
| `nodes/node-template/`                                     | Forkable base: `app/`, `graphs/`, `.cogni/repo-spec.yaml`                      |
| `packages/repo-spec/src/schema.ts`                         | Zod schema — `nodeRegistryEntrySchema`, `repoSpecSchema`                       |
| `packages/dns-ops/`                                        | DNS management for node subdomains                                             |
| `.claude/skills/dns-ops/SKILL.md`                          | DNS ops skill guide (Cloudflare setup, create-node wizard)                     |
| `infra/litellm/cogni_callbacks.py`                         | Billing callback router — routes by UUID from `COGNI_NODE_ENDPOINTS`           |
| `infra/compose/runtime/postgres-init/provision.sh`         | DB provisioning — loops over `COGNI_NODE_DBS`                                  |
| `work/items/task.0248.node-platform-package-extraction.md` | Fixes TOOL_BINDING_REQUIRED drift (composable catalog)                         |
| `work/projects/proj.operator-plane.md`                     | Multi-node deliverable tracker                                                 |
