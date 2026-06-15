---
name: validate-candidate
description: Close the deploy_verified loop for a PR flighted to candidate-a. Review the PR, confirm the candidate-a build matches the PR head SHA, enumerate impacted surfaces (API routes, UI pages, graphs), exercise each against the real deployed URL using captured authed Playwright state + agent-api-validation patterns, query Loki for observability signals from the agent's own requests, then post an approve/fail scorecard + matrix as a PR comment. Use this skill whenever the user asks to "validate the candidate-a deploy", "prove this PR on candidate-a", "close the deploy_verified loop", runs "/validate-candidate" (with or without a PR number), or asks to manually E2E-test a flighted PR. Explicitly *don't* use for pre-merge CI checks or local dev testing — this skill runs after candidate-flight has already succeeded.
---

# /validate-candidate — Manual E2E Validation Skill

## Hard rules (read first, do not violate)

1. **Zero artifacts.** This skill writes _nothing_ to disk during a validation run. No per-PR scripts. No scorecard files. No screenshots. No temp JSON. If you catch yourself reaching for `Write`, you are doing it wrong — inline the work. Playwright runs via `node --input-type=module -e '<inline JS>'` or a one-shot `node -e`. The scorecard is assembled as a shell variable or piped directly into `gh pr comment --body-file -`. Nothing in `.cogni/` gets modified either — `.local-auth/` holds only the permanent Chrome profile, storageState files, and credentials; never validation outputs.

2. **Discovery is not execution.** For a row whose surface is a graph, tool, or any behavioral capability, _running a listing endpoint to confirm it's registered does not count as the agent-axis pass_. The agent axis is 🟢 only when you actually invoked the capability and got a successful response. "The catalog contains it" is 🟡 at best and must be labeled as such.

3. **Observability must tie to the feature exercise, not ambient traffic.** Generic `request received` / `request complete` logs for a listing endpoint are not proof that your feature exercise worked. For a graph change, query for the graph's execution logs (graph-run started, tool calls, graph-run completed). For an API route change, query for the route's specific handler log line. "I found traffic at the SHA" without the feature-specific marker is 🟡, not 🟢.

## What this skill is for

A PR gets merged and `candidate-flight` turns green. That proves it builds and deploys. It does **not** prove the feature works for a real user hitting the real URL. The only gate that proves that is someone actually driving the feature on the deployed build and reading their own request back out of Loki — the project's `deploy_verified` bar (see `CLAUDE.md` "Definition of Done").

This skill is the agent-run version of that loop. Manual predecessor to the qa-agent graph in `task.0309`.

## When you're invoked

Typical user prompts:

- `/validate-candidate` (use current branch's PR)
- `/validate-candidate 1038`
- "validate the candidate-a deploy for PR #1038"
- "close the deploy_verified loop on PR 1038"

If no PR number, resolve it with `gh pr view --json number,headRefName -q .number`. If that fails (not on a branch with a PR), stop and ask.

**Dry-run mode:** if the env var `VALIDATE_CANDIDATE_DRY_RUN=1` is set, OR the user explicitly says "dry run" / "don't post a comment", do everything through scorecard assembly but **print the markdown to stdout instead of calling `gh pr comment`**. Useful for eval runs and for the user sanity-checking the skill before letting it post. Always state clearly in the final output whether the PR was commented on.

## Prerequisites — check these up front, halt on failure

1. **Captured auth state exists for the impacted env.** Check `.local-auth/<slug>.storageState.json`. The filename slug convention is `candidate-a-<node>` (e.g., `candidate-a-poly`, `candidate-a-operator`). If the file for the impacted node is missing, halt and tell the user to run the candidate-auth bootstrap (`docs/guides/candidate-auth-bootstrap.md`) for that node first. Never try to re-auth — interactive signin is out of scope for this skill.

2. **`gh` CLI authed.** `gh auth status` should be green. Stop if not.

3. **Loki access available** — either the `mcp__grafana__*` tools or the `scripts/loki-query.sh` shell helper with `GRAFANA_URL` + `GRAFANA_SERVICE_ACCOUNT_TOKEN` in env (or a sourceable `.env.cogni`). If neither works, don't halt — mark observability cells `no-grafana-data-available` and proceed with the exercise step; the gap itself is a finding worth reporting.

## The flow

### Step 1 — Load PR context

```bash
gh pr view <N> --json number,title,headRefOid,headRefName,body,files,state,statusCheckRollup
```

Capture: head SHA, changed file list, branch name, check rollup.

### Step 2 — Confirm flight state

From the check rollup, find `candidate-flight`. It must be `SUCCESS` for the PR head SHA. If it's `IN_PROGRESS` / `PENDING` / missing / `FAILURE`, **halt and report** — don't wait/poll, don't retry. The user's signal: "flight isn't green yet, re-invoke me when it is."

### Step 3 — Impact analysis: classify changed files

Group the changed files into (node, surface type). Heuristics:

| Path glob                                                | Node     | Surface type |
| -------------------------------------------------------- | -------- | ------------ |
| `nodes/<node>/app/src/app/api/**/route.ts`               | `<node>` | `api-route`  |
| `nodes/<node>/app/src/app/**/page.tsx`, `view.tsx`, etc. | `<node>` | `ui-page`    |
| `packages/langgraph-graphs/src/graphs/**`                | operator | `graph`      |
| `apps/operator/src/app/api/**/route.ts`                  | operator | `api-route`  |
| `apps/operator/src/app/**/page.tsx`                      | operator | `ui-page`    |
| `infra/**`, `.github/workflows/**`                       | —        | `infra`      |
| `docs/**`, `work/**`, `*.md`                             | —        | `docs`       |
| `scripts/**`, `.claude/**`, root configs                 | —        | `tooling`    |
| everything else                                          | —        | `other`      |

Before choosing concrete validation routes for an impacted node, read its
node-local validation guide if present:

```bash
test -f nodes/<node>/.cogni/validation.md && sed -n '1,220p' nodes/<node>/.cogni/validation.md
```

Use that guide to resolve node-specific human-axis routes, auth prerequisites,
agent-axis probes, and Loki selectors. The default convention is that standalone
nodes are node-at-root apps on their own candidate subdomain. Do not assume a
`/nodes/<slug>` detail route exists for every node. The operator is the known
exception: its own gallery detail route is `/nodes/operator`, documented in
`nodes/operator/.cogni/validation.md`.

Build an **impact matrix** — one row per distinct (surface type × concrete target). For a UI page, the row target is the route (`/credits`, `/profile`). For an API route, the target is the method + path. For a graph, it's the graph name.

### The two axes: Human and Agent

Every _behavioral_ feature (not a purely internal refactor) lives on two axes at once, and the skill must try both:

- **Human axis** — a person drives the feature through the UI with Playwright + captured storageState. "Does clicking through the product actually do the thing?"
- **Agent axis** — an agent or API client calls the underlying route/tool/graph directly. "Does the capability exist at all on the deployed build?"

The two can disagree, and the disagreement is often the most useful finding:

| Agent axis | Human axis | What it means                                                                                                                                                             |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🟢 pass    | 🟢 pass    | Feature actually works end-to-end. Rarest, most valuable signal.                                                                                                          |
| 🟢 pass    | 🔴 fail    | **Drift surfaced.** Backend shipped, UI didn't. Graph exists but no chat entry point, tool registered but no settings toggle, etc. This is a real bug — flag prominently. |
| 🔴 fail    | 🟢 pass    | UI is lying — fake success states, stale cache, or the click routes somewhere else. Higher severity than agent-only fail.                                                 |
| 🔴 fail    | 🔴 fail    | Deploy is broken. Halt-worthy.                                                                                                                                            |
| 🟢 pass    | n/a        | Backend-only change with no UI surface. Expected for many PRs.                                                                                                            |
| n/a        | 🟢 pass    | UI-only change (copy, styling). Expected for frontend PRs.                                                                                                                |

Every row in the matrix therefore carries **two verdict cells** (Human · Agent) — not one — plus a separate observability cell per axis. The final `## Impact matrix` table always shows both columns.

Node → candidate-a URL map:

- `operator` → `https://test.cognidao.org`
- `poly` → `https://poly-test.cognidao.org`
- `resy` → `https://resy-test.cognidao.org`

### Step 4 — Confirm buildSha matches PR head

For each _unique_ node in the impact matrix, curl `<node-url>/version`:

```bash
curl -sf https://poly-test.cognidao.org/version | jq .buildSha
```

Compare to the PR head SHA from step 1 (prefix match — `/version.buildSha` is usually full SHA, PR head is too; accept either equal or one being a prefix of the other). If mismatch, halt and report — candidate-a is serving a different build than the PR you're validating. The user needs to re-flight or wait.

### Step 5 — Exercise each matrix row on both axes

For each row, try **both** the agent axis and the human axis. Skip an axis only when it genuinely doesn't apply (record as `n/a` with reason).

#### Agent axis strategies

- **`api-route`** — prefer the agent-api-validation flow from `docs/guides/agent-api-validation.md` (API key / service token). If the endpoint requires a user session, fall through to using the captured storageState cookies with `fetch` / `curl` (extract the session cookie from `.local-auth/<slug>.storageState.json` and pass as `Cookie:` header).
- **`graph` — EXECUTE, don't just list.** Find the real invocation route (typically `POST /api/v1/agent/runs` or `POST /api/v1/ai/chat` — inspect the node's routes if unsure) and POST a run request that selects the graph by its registered agentId (e.g. `langgraph:poly-research`). Include a minimal realistic input. Await the response and, if streaming, read at least the first few stream chunks to confirm the graph started. Row is 🟢 only when the run reached a terminal state or at least produced structured output indicating the graph executed. A `GET /api/v1/ai/agents` listing is _discovery_, not _execution_ — it's allowed as a secondary check but cannot be the only agent-axis evidence.
- **tool registration** — discovery only; mark 🟡 with note unless you can also invoke the tool end-to-end via a graph that uses it (preferred).

#### Human axis strategies

Drive the UI with **`playwright-cli`** (available as a skill-allowed tool). Its `state-load` reads the same JSON schema `capture-authed-state.mjs` writes, so captured storageState works as-is. Prefer it over inline Node / `@playwright/test` heredocs — one bash call per action, snapshots give accessibility refs, built-in `network` / `console` taps remove event-listener boilerplate.

- **`ui-page`** — load state, open, snapshot to get element refs, click/type, snapshot again to verify, read `network` to confirm the downstream API call fired.
- **`graph` or `tool` behind the UI** — open the chat page, snapshot, find the agent/graph picker, open it, re-snapshot. If the new graph's displayName is absent from the opened-menu snapshot → row is 🔴 **drift**: "graph `<name>` registered backend-side but not exposed in chat UI". That's the drift the matrix exists to catch.

**Canonical sequence** (one ephemeral session, zero durable artifacts):

```bash
playwright-cli -s=validate state-load .local-auth/candidate-a-<node>.storageState.json
playwright-cli -s=validate open https://<node>.cognidao.org/<route>
playwright-cli -s=validate snapshot                 # element refs
playwright-cli -s=validate click e<N>               # exercise the change
playwright-cli -s=validate snapshot                 # verify outcome
playwright-cli -s=validate network                  # downstream API calls
playwright-cli -s=validate console                  # client-side errors
playwright-cli -s=validate close                    # tear down
```

Record per row: the refs clicked, the post-click snapshot excerpt proving the outcome, the `network` line (method + path + status), any `console` errors. Snapshot yaml files playwright-cli writes under `.playwright-cli/` are its own working state — not validation artifacts we author; never reference them in the scorecard, and ensure `.playwright-cli/` is gitignored.

#### When to skip an axis

- **agent-axis n/a:** frontend-only change (CSS, copy, layout) with no backend contract change. Human-axis is the only meaningful check.
- **human-axis n/a:** backend-only change with no intended UI surface (internal scheduler, cron-like tool, infra). Mark it, don't invent a fake click path.
- **both n/a:** `docs`, `tooling`, `infra`-only. Entire row is n/a with short reason.

**Record for each exercised axis:** timestamp the exercise started (UTC ISO), observed HTTP responses or visible assertion, pass/fail verdict.

**For any axis you truly can't figure out how to exercise** — mark `skipped` with the reason rather than halting, and ding the final verdict toward 🟡.

### Thoroughness — when one row hides a family

The headline matrix has one row per impacted surface, but a single "surface" often hides a **family of members** — a set of related endpoints, tools, or capabilities — and a 🟢 row that only exercised one member silently passes the rest. PR #1033 is the canonical lesson: the `poly-research graph` row was 🟢 after 2 probes, but a per-tool sweep revealed 2/8 tools were broken (wrong endpoint, schema mismatch). The top-level scorecard said PASS while the actual feature was 75% functional.

**Trigger conditions for a sub-matrix sweep** — apply when any of these are true:

- The PR introduces ≥3 new tools, endpoints, schemas, or graphs of the same shape (`core__*_<x>` cluster, `/api/v1/<resource>/*` cluster, `*Capability.method()` cluster).
- The PR wraps a third-party API where each method maps to a distinct upstream endpoint and schema.
- The PR purges, replaces, or rewrites a member of an existing family — adjacent untouched members may share the same root cause.
- One row's agent-axis evidence covers the easy case and you're tempted to extrapolate to the rest.

**How the sub-matrix works:**

- One sub-matrix row per family member. Columns mirror a tool-test pattern: `MEMBER · PROBE · LOKI ai.tool_call.error · OVERALL`.
- Each member gets its own one-shot exercise — for tools, that means one `chat/completions` turn per tool with a direct `Call <tool-name> with <args>. Return raw JSON, no commentary.` prompt; for endpoints, one `curl` per route. 4o-mini follows direct-named tool prompts cleanly; do not chain.
- Probe payload should hit the real upstream (real wallet, real conditionId, real handle) — discovered live, not invented. Hallucinated identifiers reproduce the original bug.
- Source identifiers from working endpoints first (e.g. grab a `proxyWallet` from `/v1/leaderboard`, a `conditionId` from `/trades`), then re-use across probes.
- Loki sweep at the end: one query for `ai.tool_call.error` across the whole batch's runIds — surfaces silent-fail tools that returned 200 to the agent but logged a typed validation error underneath.

**Posting:** the sub-matrix lives in a **second PR comment**, not embedded in the headline scorecard (which stays exactly as locked in §"Exact scorecard format"). Title it `## /validate-candidate — PR #<N> · <sha-short> · per-<family> probe matrix · <verdict>`. Cross-link from the headline scorecard's NOTES line if findings warrant it.

**Example shape** (verbatim from PR #1033 follow-up):

```
| TOOL                              | PROBE | LOKI ai.tool_call.error | OVERALL              |
| --------------------------------- | ----- | ----------------------- | -------------------- |
| core__poly_data_help              | 🟢    | —                       | 🟢 PASS              |
| core__poly_data_value             | 🟢    | —                       | 🟢 PASS              |
| core__poly_data_holders           | 🔴    | 1 hit                   | 🔴 SCHEMA-MISMATCH   |
| core__poly_data_resolve_username  | 🟡    | —                       | 🔴 WRONG-ENDPOINT    |
```

Then the EVIDENCE block lists every runId with its outcome and the ROOT CAUSE block explains each 🔴 with the actual upstream shape. Required follow-ups go inline as `bug.<NNNN>` items so the PR author can decide fix-in-PR vs split.

**Cost discipline still applies.** Sub-matrices add LLM cost — one chat/completions turn per family member at the smallest model the graph supports (gpt-4o-mini is fine for direct probes). Skip the sweep when the family has <3 members or when an axis-1 exercise already covered every member implicitly (e.g. a contract-shape PR where each consumer of the contract is exercised by the headline row).

**When to escalate:** if the sub-matrix surfaces a 🔴 that wasn't visible in the headline run, the headline verdict drops to 🔴 and the NOTES line MUST cross-link the sub-matrix comment. Do not leave a 🟢 headline standing while a 🔴 sub-matrix sits below it — that recreates exactly the false-confidence the sweep is designed to catch.

### Step 6 — Observability: find the **feature-specific** log of your own call

For each exercised row, query Loki for evidence your exercise _did the thing_, not just that traffic reached the pod.

Time window: `start = exercise_start - 10s`, `end = now + 10s`.

Grounding labels (confirmed present on `grafanacloud-logs`): `namespace="cogni-candidate-a"`, `pod=~"<node>-node-app-.*"`, plus the JSON-parsed fields `reqId`, `traceId`, `userId`, `route`, `msg`.

**Tier the query. Stop at the first tier that returns ≥1 line:**

1. **Feature-specific marker** (strongest). For a graph change: the log line emitted when the graph runs (`msg=~"graph.run"` or `msg="<graph-name>_started"` or equivalent — inspect the node's `src` for the actual log emitters). For an API route change: the route's handler emit (e.g. `route="poly.wallet.connect"`, `msg="poly.wallet.connect_success"`). **Row is 🟢 only at this tier.**
2. **reqId/traceId correlation.** If your inline Playwright / fetch captured a response `x-request-id` or a cookie-session trace header, query `|~ "<reqId>"`. Proves _your specific call_ reached the pod.
3. **userId + route.** `| json | userId="<you>" | route="<feature-route>"` narrowed to the exercise window. Row is 🟡 at this tier — proves traffic from you but not necessarily the feature behavior.
4. **Ambient pod traffic only.** `| json | route="<feature-route>"` without user/trace correlation. This is essentially "the endpoint exists and took traffic" — 🟡 with a note explaining you couldn't prove the specific call was yours.

If only tier 4 matches, the observability cell is 🟡, not 🟢 — regardless of how many lines came back. Do not grant 🟢 to generic traffic. The skill exists to catch drift, and drift hides behind ambient success.

**Loki access — two paths, prefer whichever is available:**

- `mcp__grafana__query_loki_logs` (MCP) — use when connected. Datasource uid: `grafanacloud-logs`.
- `scripts/loki-query.sh '<logql>' [mins_back] [limit]` (shell fallback) — no MCP dependency. Reads `GRAFANA_URL` + `GRAFANA_SERVICE_ACCOUNT_TOKEN` from env (or `.env.cogni` auto-sourced). Outputs raw Loki JSON on stdout — pipe through `jq` to filter.

Example shell-fallback queries:

```bash
scripts/loki-query.sh '{namespace="cogni-candidate-a", pod=~"poly-node-app-.*"} | json | route="<feature-route>"' 5 50 | jq '.data.result[].values[][1] | fromjson | {ts:.time, reqId, msg, route, status}'
```

**If neither path is available** (MCP disconnected and the token isn't in env) — mark every observability cell `no-grafana-data-available` and note it in the scorecard. **Do not halt.** Missing observability is a gap worth surfacing, not a reason to abandon the run. The human-axis + agent-axis evidence still stands on its own.

### Step 7 — Post the scorecard (zero artifacts)

Build the markdown **in memory only**. Post it via stdin:

```bash
echo "$SCORECARD_MD" | gh pr comment <N> --body-file -
```

Do not write the scorecard to a temp file under any circumstances, including `/tmp`. If the harness blocks shell heredocs with unquoted variables, hold the markdown in a bash variable (`SCORECARD_MD=$(cat <<'MARKDOWN' ... MARKDOWN)`) and pipe it. Dry-run mode skips this step entirely — print the markdown to stdout and stop.

### Exact scorecard format — DO NOT deviate

This shape is locked. Derek reads the terminal paste of this markdown directly — cell widths, emoji-only state columns, and the evidence block below the table are all load-bearing. If you shorten, widen, merge columns, or drop the code-block evidence section, the scorecard stops being legible. Match to the character.

````markdown
## /validate-candidate — PR #<N> · `<sha-short>` · <🔴 FAIL | 🟡 NOTES | 🟢 PASS>

| PR TWEAK          | HUMAN | AI  | LOKI | OVERALL     |
| ----------------- | ----- | --- | ---- | ----------- |
| <TWEAK-NAME-CAPS> | 🔴    | 🔴  | 🟢   | 🔴 FAIL     |
| <TWEAK-NAME-CAPS> | —     | 🔴  | 🟢   | 🔴 DRIFT    |
| <TWEAK-NAME-CAPS> | —     | 🟡  | 🟡   | 🟡 INDIRECT |
| <TWEAK-NAME-CAPS> | —     | 🟡  | 🟡   | 🟡 UNPROVEN |
| <TWEAK-NAME-CAPS> | —     | —   | —    | ⚪ N/A      |

EVIDENCE

```
    pod  <pod-name>  ·  sha <sha-short>
    ────────────────────────────────────────────────────────────
    <one exercise per line, padded for column alignment>
    <e.g.  POST /chat  graphName="foo"   → 404   reqId abc12345>
```

NOTES <one line, dot-separated — cross-PR collisions, pre-existing issues, flight-status caveats>
````

Constraints that hold every invocation:

1. **Rows are "PR tweaks"** — the concrete surfaces this PR introduces or modifies. One per impacted surface. n/a rows come last. Docs-only PRs may have a single n/a row summarizing the lack of impact.
2. **Four emoji columns — HUMAN · AI · LOKI · OVERALL.** Single emoji only, or `—` for n/a. HUMAN = Playwright evidence. AI = API / agent-first exercise. LOKI = observability tier 1 only (see §6 — otherwise 🟡). OVERALL takes one CAPS label after the emoji (FAIL / DRIFT / INDIRECT / UNPROVEN / PASS / N/A).
3. **Header row padded to fixed widths** — `PR TWEAK` column ~22 chars, state columns ~5, OVERALL ~14. Rows must match. No cell wraps in the rendered output; if a name doesn't fit, shorten it, don't let it spill.
4. **Evidence lives in a fenced code block below the table.** Never in the cells. Each exercise is one padded line: `METHOD  path  detail  → status  reqId-or-marker`. Keep the column alignment.
5. **NOTES is one line, dot-separated.** If you need more than one line you're burying signal — cut or split into a second validation pass.

Verdict in the heading:

- `🔴 FAIL` — any row's OVERALL is 🔴.
- `🟡 NOTES` — no reds, but one or more 🟡 exists (unproven, indirect, partial observability, stale auth, etc.).
- `🟢 PASS` — rare; every non-n/a row is 🟢 across all three axes.

## Verdict rules

Aggregate across matrix rows. A row's axes combine like this:

- Both axes 🟢 → row is 🟢
- One axis 🟢, other 🔴 → row is 🔴 (the disagreement _is_ the finding)
- One axis 🟢, other n/a → row is 🟢
- Any axis 🔴 with a `drift` note → row is 🔴 but labeled drift (backend-vs-UI mismatch, not a build break)
- Skipped axis (couldn't figure out how to exercise) → row is 🟡

Overall verdict:

- 🟢 **approve** — every non-n/a row is 🟢 _and_ every exercised axis has 🟢 observability. Rarest outcome. Means every axis of every impacted surface was driven end-to-end and its request was found in Loki at the deployed SHA.
- 🟡 **approve-with-notes** — all exercises pass but something's soft: observability partial/missing, an axis skipped, captured auth missing for a secondary surface, etc. Document what's unproven.
- 🔴 **fail** — any row 🔴 from actual exercise failure (non-2xx, broken click path, visible error), OR deployed buildSha mismatch, OR flight not green. **Drift-class 🔴** (backend ships without UI) is still 🔴 — call it out prominently in the summary paragraph so reviewers can decide whether to merge anyway or wait for the UI surface.

Err on the side of 🟡 when in doubt. Don't give 🟢 to something you couldn't actually observe.

## What this skill deliberately does _not_ do

- **No work-item frontmatter edits.** `deploy_verified: true` on the work item is noise — the PR comment is the signal. (Explicit user feedback.)
- **No screenshot upload** (vNext — tracked as a follow-up).
- **No retrying** a failed flight or stale build. Report and stop; the user decides whether to re-flight.
- **No interactive auth.** Captured storageState only. If it's missing, halt with a pointer to the bootstrap guide.
- **No synthesizing data** for observability. If you didn't see it in Loki, say so — don't guess.

## Cost discipline

UI page exercise runs are cheap (headless Chromium, single pageview). API route exercises are single HTTP calls. Loki queries should be scoped by `namespace` and SHA to avoid full-volume scans. If a row's exercise needs more than ~30s of automation, you're probably over-engineering — simplify to the minimum click sequence that would fail if the PR were broken.

## If you get stuck

- Can't figure out what surface a file belongs to → mark it `other` / skipped with reason, move on.
- Playwright doesn't find the expected element → capture the page's visible text + button list, include in notes, mark the row 🟡.
- API returns 5xx → that's a 🔴 fail for the row; include the response body (truncated) in the exercise cell.
- Captured storageState rejected (redirects to signin) → cookie expired. Halt the UI exercises for that node, note the refresh need, continue with API-only rows if feasible.
- Node's app/pod is missing on candidate-a, or you want to know if Argo generated/synced it → **do not reach for `kubectl`.** The applicationset/application controllers ship every generate/prune/sync event to Loki; query the Argo control-plane recipe in [`promote`](../promote/SKILL.md) (§"When `/version.buildSha` doesn't advance — Loki, not SSH", stream #4). No kubeconfig, no SSH.

## Key repo pointers

- `docs/guides/candidate-auth-bootstrap.md` — how the storageState files get created (prereq)
- `docs/guides/agent-api-validation.md` — API-flow reference
- `nodes/<node>/.cogni/validation.md` — node-local candidate-a route and probe guide when present
- `.claude/skills/operator-app-auth-routing/SKILL.md` — operator-specific auth, route group, proxy, and public chrome guidance
- `scripts/dev/smoke-authed-state.mjs` — template for authed Playwright runs
- `.local-auth/*.storageState.json` — the captured sessions (gitignored)
- `work/items/task.0309.qa-agent-e2e-validation.md` — the graph-agent successor
- `work/projects/proj.cicd-services-gitops.md` (E2E Success Milestone section) — the bar this skill works toward
