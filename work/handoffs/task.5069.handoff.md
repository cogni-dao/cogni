---
id: task.5069.handoff
type: handoff
title: "DoltHub push hook handoff (task.5069 + PR #1360)"
related_task: task.5069
related_pr: 1360
related_project: proj.knowledge-syntropy
related_knowledge: dolt-remote-v0
status: in_progress
created: 2026-05-28
owner: derekg1729
---

# DoltHub push hook — handoff to successor agent

## What you're picking up

PR #1360 is open on `derekg1729/dolthub-env-wiring`. It plumbs **three** env vars through every surface (Zod schema, compose dev/prod, deploy-infra.sh ×3 places, two GitHub workflows, SETUP_DESIGN.md, setup-secrets.ts catalog, .env.operator.example):

- `DOLTHUB_API_TOKEN` — **v0 push job uses this** (PAT, app-level, one-way mirror)
- `DOLTHUB_OAUTH_CLIENT_ID` + `DOLTHUB_OAUTH_CLIENT_SECRET` — **reserved for v1** per-user identity (librarian / x402). Pre-wired but no v0 reader.

No runtime consumer for any of them yet — pure plumbing.

Task **task.5069** is the substantive follow-up: build the prod-side push hook keyed off `DOLTHUB_API_TOKEN`. Drop OAuth callback work; that moves to a separate v1 task.

Decision context lives in:

- Knowledge entry `dolt-remote-v0` (filed as contribution `contrib-derek-claude-curitiba-81daec98`, awaiting merge on cognidao.org/knowledge?mode=inbox) — convention + topology summary
- `proj.knowledge-syntropy.md` — umbrella roadmap; the push hook is the W0c tier

## Hard constraints you must honor

| Invariant                                              | Where it lives                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| Polyrepo on DoltHub, never monorepo                    | `dolt-remote-v0` knowledge entry; one DoltHub repo per node hub |
| Repo name = `knowledge-<node>` (kebab)                 | matches Doltgres DB `knowledge_<node>` (underscore→hyphen)      |
| One operator-owned PAT pushes for all nodes (v0)       | not per-node tokens; per-fork is out of scope                   |
| Direction v0: prod → DoltHub → others pull             | no test→prod merges; bidirectional is v1+                       |
| Push is best-effort, never raises `KnowledgeGateError` | local merge succeeds even when push fails; log the error        |
| `DOLT_REMOTE_PUSH_ENABLED=true` only on prod           | dev/test/candidate-a default to local-only                      |

## Pivot from prior handoff: OAuth → PAT

Derek created `DOLTHUB_API_TOKEN` for all envs (same token for v0). Reasons OAuth is deferred:

- DoltHub OAuth apps gate production with a manual approval queue (DoltHub-side)
- v0 push is app-level — no per-user identity needed
- Callback endpoint + token refresh logic is meaningful surface; v1 should own it

The OAuth env wiring stays in #1360 as **pre-wiring for v1** — file a separate task (linked below) so the OAuth secret pair has a tracked owner and isn't orphan config.

## Open questions you'll have to answer

1. **Doltgres ↔ DoltHub push semantics**: Does `CALL dolt_push('origin', 'main')` work against a Doltgres database with a remote pointing at DoltHub's HTTP remote API? Verify before wiring. If not, a sidecar with `dolt` CLI may be needed.
2. **Remote URL + auth**: Dolt convention is `https://doltremoteapi.dolthub.com/<owner>/<repo>` with `DOLT_REMOTE_USER` + `DOLT_REMOTE_TOKEN` env. Test that `DOLTHUB_API_TOKEN` works in `DOLT_REMOTE_TOKEN` slot.
3. **Push timing**: synchronous in the merge handler (adds latency) or fire-and-forget after `svc.merge()` returns? Lean: fire-and-forget. Merge already returns `commitHash`.
4. **Remote registration**: idempotently `CALL dolt_remote('add', 'origin', …)` on container startup, or first-use in the push path? Lean: startup, so failures surface early.

## What "done" looks like

1. On prod, after a knowledge contribution is merged via the inbox UI, the operator container pushes the new commit to `https://www.dolthub.com/cogni-dao/knowledge-<node>` within ~5s. Visible in the DoltHub UI.
2. Disable `DOLT_REMOTE_PUSH_ENABLED` → merges succeed locally with no push attempt. Re-enable → resumes.
3. Push failures logged at warn level via Pino with `commitHash` + `remoteError`; never bubble up to the user.
4. candidate-flight green; `/validate-candidate` proves the push path with a fresh probe entry merged from inbox.

## Files to read first (in order)

1. `work/projects/proj.knowledge-syntropy.md` — umbrella roadmap context
2. `.claude/skills/knowledge-syntropy-expert/SKILL.md` — action hierarchy + invariants
3. `docs/spec/knowledge-data-plane.md` — Sharing+Federation section (will be edited in this task)
4. `packages/knowledge-store/src/adapters/doltgres/contribution-adapter.ts:497-548` — `merge()` method, the seam
5. `packages/knowledge-store/src/service/contribution-service.ts:223-228` — service `merge()`, where a post-merge callback could be injected
6. `nodes/operator/app/src/app/api/v1/knowledge/contributions/_handlers.ts:274-315` — `handleMerge` HTTP handler, fire-and-forget point
7. `nodes/operator/app/src/bootstrap/container.ts:604-627` — DI for `doltClient`
8. PR #1360 diff — see exactly what env wiring landed

## File pointers (where new code goes)

- `packages/knowledge-store/src/port/contribution.port.ts` (or new `dolt-remote.port.ts`) — `pushToRemote(args)` interface
- `packages/knowledge-store/src/adapters/doltgres/contribution-adapter.ts` — implement via `sql.unsafe(\`CALL dolt_push('origin','main')\`)`
- `nodes/operator/app/src/app/api/v1/knowledge/contributions/_handlers.ts:~311` — fire-and-forget `port.pushToRemote(...).catch(log)` after `svc.merge()`
- `nodes/operator/app/src/bootstrap/container.ts:~615` — read `DOLTHUB_API_TOKEN` + `DOLT_REMOTE_PUSH_ENABLED`, inject into adapter
- `infra/compose/runtime/doltgres-init/provision.sh` — idempotent `CALL dolt_remote('add','origin',…)` post-CREATE DATABASE
- `docs/spec/knowledge-data-plane.md` — refine Sharing+Federation + add 2 new invariants
- `work/charters/KNOWLEDGE.md` — flip "Dolt remotes" ask from 🔴 to 🟡 when this PR lands

## Anti-patterns specific to this task

- **Don't push from candidate-a/test/preview.** They pull from DoltHub. Pushing from multiple envs creates merge surprises. Gate on `APP_ENV === 'production'` AND `DOLT_REMOTE_PUSH_ENABLED === 'true'`.
- **Don't surface push errors as `KnowledgeGateError`.** Push is best-effort; the merge already succeeded.
- **Don't add a new gate for the push path.** Push happens AFTER `svc.merge()`. Gates apply at the write boundary, not the replication seam.
- **Don't ship OAuth callback in this task.** That's its own v1 task with its own design + test plan.
- **Don't rip the OAuth env wiring.** It's purposed pre-wiring for the v1 OAuth task. Removing it would just churn the env surfaces twice.

## Status as of this handoff

- PR #1360: env wiring complete for **both** PAT (v0) and OAuth pair (v1 pre-wire). CI on the latest push.
- task.5069: scope narrowed to PAT-based push hook only (no OAuth callback)
- task.5070: filed — DoltHub OAuth callback (v1, per-user identity for librarian / x402). This is the tracked owner for the pre-wired `DOLTHUB_OAUTH_CLIENT_ID/SECRET` so they're not orphan config.
- Knowledge entry `dolt-remote-v0`: contribution staged on prod, awaiting merge

## Successor checklist

- [ ] Merge or wait for #1360
- [ ] Verify Doltgres ↔ DoltHub push semantics (spike if uncertain — small standalone script first)
- [ ] Implement `pushToRemote` adapter method + DI wiring
- [ ] Wire fire-and-forget push in `handleMerge` post-`svc.merge()`
- [ ] Add idempotent `dolt_remote add` to provision.sh
- [ ] Refine `knowledge-data-plane.md` § Sharing+Federation
- [ ] Flight to candidate-a (push is gated off there, so just verify it doesn't fire)
- [ ] Promote to prod, `/validate-candidate` with a real DoltHub push probe
- [ ] Update charter scorecard: Dolt remotes 🔴 → 🟡
