---
name: node-sync-prs
description: Use whenever a MERGED operator/monorepo change must be propagated to the node repos that each carry their OWN COPY of the affected code — packages/knowledge-store, packages/knowledge-base, the cognition bundle route, repo-spec generators, schema, or any shared substrate. Trigger for "port this to node-template and the nodes", "adopt the operator standard everywhere", "sync the delete-op / bundle / schema change to all nodes", "mirror PR #N across nodes", "node-template still has the old behavior". For CI/CD WORKFLOW-FILE syncs specifically, defer to the sibling node-template-infra-sync-prs (this is the general case; that is the CI playbook). End state: the operator app should auto-port these (dependabot-style); until that ships, this is the manual process.
---

# Node Sync PRs — propagate an operator standard to every node

Cogni nodes each carry their **own copy** of shared code (`packages/knowledge-store`, `packages/knowledge-base`, the `cognition` bundle route, `repo-spec` generators, schema). **There is no auto-sync.** One merged operator change → one PR per node repo. Without a deliberate sweep, the standard drifts: forks keep the old behavior (e.g. soft-deprecate after operator moved to delete) and every agent on those nodes gets the stale contract at session start.

> **Why this is a skill, not a one-off:** every operator standard change needs this until the operator app does it automatically (a dependabot-for-nodes). Run it the same way each time so nothing is missed and the result is auditable.

## Core rule — one ledger, one PR per repo

Maintain a 1:1 ledger; never batch repos into one PR.

```text
upstream change → target repo → mirror branch → PR URL → check state → merge state
```

Save it at `.context/node-sync-prs/<upstream-pr-or-sha>.json`, update on every discover/skip/open/fix/merge/block. Reuse the JSON shape from [`node-template-infra-sync-prs`](../node-template-infra-sync-prs/SKILL.md) (`upstream`, `canonical`, `targets[]`, `skipped[]`).

## 1. Define the change

- Identify the merged upstream PR/commit and its **canonical files** (`git show --stat <sha>`).
- Decide per file: **byte-for-byte** (pure shared substrate, identical across repos) vs **targeted edit** (the file has drifted — same logical block, different surrounding code / line numbers).
- Knowledge-store/base, bundle, and schema files drift between repos (line numbers differ), so they are usually **targeted edits** (`old_string`→`new_string` of the changed block), NOT a whole-file copy. CI workflow files are usually byte-for-byte → use `node-template-infra-sync-prs`.

## 2. Enumerate targets (every node, not just the obvious ones)

1. **`Cogni-DAO/node-template`** — the canonical node-at-root template; **always first** (every new node forks it).
2. **Forks / spawned nodes** — read `infra/catalog/*.yaml` `source_repo` rows in the operator repo (`rg -n '^source_repo:' infra/catalog`); normalize to `owner/repo`. Known live forks: `blue`, `habitat`, `oss`.
3. **Test org** — `gh repo list cogni-test-org --limit 100 --json nameWithOwner,isArchived,defaultBranchRef`; include `cogni-test-org/node-template` + `cogni-test-org/test-cog`; skip archived + throwaway wizard spawns.
4. Any repo the user names directly.

The `nodes` Postgres table is the real SSoT for spawned nodes (catalog/`.gitmodules` miss some) — if you can query it, prefer it; otherwise catalog + the known list.

## 3. Confirm each target actually needs the change (drift check)

For each candidate, fetch the canonical file and grep for the OLD vs NEW marker before opening a PR:

```bash
repo=Cogni-DAO/node-template
gh api "repos/$repo/contents/packages/knowledge-store/src/adapters/doltgres/contribution-adapter.ts?ref=main" \
  --jq .content 2>/dev/null | base64 -d | grep -nE 'edit.op === "deprecate"|edit.op === "delete"'
```

Classify `needs-port` / `current` / `absent (no such file — skip with reason)`.

## 4. Port — one branch, one PR per repo

Prefer a **local clone** for multi-file mechanical edits (GitHub API single-file PUT is fine for one or two files). Apply the SAME logical edits the upstream PR made — match the changed block, not line numbers.

```bash
tmp=$(mktemp -d); gh repo clone "$repo" "$tmp" -- --depth 1
# apply the same old_string→new_string edits per file (see upstream diff)
cd "$tmp" && git switch -c codex/sync-<change>-<upstreamPR>
git commit -am "feat: adopt operator <change> (port of Cogni-DAO/cogni#<N>)"
git push -u origin HEAD
gh pr create --repo "$repo" --base main --title "..." --body "Port of Cogni-DAO/cogni#<N>. <one-line what+why>."
```

Reuse an existing open sync PR for the same repo/purpose — never open PR #2 for the same target. Don't disturb unrelated branch changes.

## 5. Verify + report

- `gh pr view <n> --repo <repo> --json url,state,mergeable,statusCheckRollup,files` — confirm the changed files match the intended set and checks go green (don't call it ready while `PR Build` is pending).
- Forks may merge via their own process; record blockers (permissions, CI) explicitly rather than calling them green.
- Final answer = the ledger table: `repo | PR | state | checks | notes`, including skipped repos + reasons.

## Discipline

- **node-template first**, then forks — forks inherit the template, so the canonical port is highest leverage.
- **Targeted edits over whole-file copy** for drifted code; byte-for-byte only for genuinely identical files.
- **No silent skips** — every enumerated repo lands in `targets[]` or `skipped[]` with a reason.
- This is interim. The durable fix is operator-app auto-sync (dependabot-for-nodes); note that as the standing follow-up, don't re-solve it per port.
