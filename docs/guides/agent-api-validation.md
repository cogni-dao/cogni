---
id: agent-api-validation-guide
type: guide
title: Agent-First API Validation (Candidate-A + Local)
status: draft
trust: draft
summary: API proof recipe for machine-agent discovery, auth, work-item coordination, route exercise, and graph run validation.
read_when: Validating an HTTP/API surface locally or against candidate-a, especially inside /validate-candidate.
owner: derekg1729
created: 2026-04-08
verified: 2026-10-03
tags: [agent-api, validation, candidate-a, billing]
---

# Agent-First API Validation (Candidate-A + Local)

This guide is a **route exercise recipe**, not the full contribution lifecycle.
For the lifecycle, use [`docs/spec/development-lifecycle.md`](../spec/development-lifecycle.md).
For post-flight PR validation, use [`.claude/skills/validate-candidate`](../../.claude/skills/validate-candidate/SKILL.md); it owns the scorecard and Loki evidence format.

## Prereqs

- [ ] Running target: `pnpm dev:stack` (local) **or** live candidate-a URL.
- [ ] Funded wallet + funded billing account for the node under test.
- [ ] `curl`, `jq`, and SSE-capable client (`curl -N` is enough).

## Quickstart — free poem in 3 calls

```bash
BASE=http://localhost:3000

# 1. Discover
curl $BASE/.well-known/agent.json | jq .

# 2. Register (no wallet required)
CREDS=$(curl -s -X POST $BASE/api/v1/agent/register \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent"}')
API_KEY=$(echo $CREDS | jq -r .apiKey)

# 3. Request poem (graph_name is required — routes through platform key)
curl -s -X POST $BASE/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"gpt-oss-120b","graph_name":"poet","messages":[{"role":"user","content":"Write a haiku about APIs."}]}'
```

> **Why `graph_name`?** Without it, completions tries a direct LiteLLM call using a per-user
> virtual key that doesn't exist for newly registered agents. Routing via a named graph uses
> the platform key instead. This is a known gap — see shortcomings below.

## Work items — the contribution ledger

Every code change is tied to exactly one work item. **1 work item ≈ 1 PR.** Prefer adopting an existing item over creating one (anti-sprawl). Items stay lean — a one-line `outcome` describing successful E2E validation.

Human-facing status must link the authenticated permalink
`$BASE/work/items/$ID`. The `/api/v1/work/items/$ID` URL is a machine endpoint,
not a human permalink; `/work?q=$ID` is only a filtered list, not a permalink.
Do not publish either as human proof. Do not publish the disposable validation
row below: it is intentionally deleted after the round trip.

```bash
# Discover open work
curl -H "Authorization: Bearer $API_KEY" \
  "$BASE/api/v1/work/items?statuses=needs_implement,needs_design"
```

**Lifecycle close gate:** PATCH `status=done` only after PR merges to `main`. Pre-merge stays `needs_merge`; rejected review flips back to `needs_implement`.

### Node-local fresh-agent work-item validation

Run this disposable round trip against the node being validated. `BASE` must be
that node's own origin; the procedure deliberately has no operator fallback and
does not send a `node` field. One freshly registered node agent owns the entire
sequence: discover → register → create → claim → heartbeat → patch →
done readback → release → delete → `404`. The discovery checks prove the
node advertises every operation before the client mutates its local work-item
store.

This is a temporary executable validation client owned by
[story.5060](https://cognidao.org/work/items/story.5060). That story must
migrate or delete it if durable hub guidance supersedes this procedure.
The disposable probe is not a contribution work item: its brief `done` state
exists only to prove terminal-state persistence before the row is deleted.

```bash
set -euo pipefail

: "${BASE:?set BASE to the node origin under validation}"
BASE=${BASE%/}
RUN_ID="work-item-validation-$(date -u +%Y%m%dT%H%M%SZ)-$$"
COMMAND="/validate-candidate"

# Discover the node-local registration and work-item actions.
AGENT_JSON=$(curl -fsS "$BASE/.well-known/agent.json")
jq -e --arg base "$BASE" '
  .registrationUrl == ($base + "/api/v1/agent/register") and
  .actions.createWorkItem.method == "POST" and
  .actions.createWorkItem.endpoint == ($base + "/api/v1/work/items") and
  .actions.claimWorkItem.method == "POST" and
  .actions.claimWorkItem.endpoint == ($base + "/api/v1/work/items/{id}/claims") and
  .actions.heartbeatWorkItem.method == "POST" and
  .actions.heartbeatWorkItem.endpoint == ($base + "/api/v1/work/items/{id}/heartbeat") and
  .actions.updateWorkItem.method == "PATCH" and
  .actions.updateWorkItem.endpoint == ($base + "/api/v1/work/items/{id}") and
  .actions.releaseWorkItem.method == "DELETE" and
  .actions.releaseWorkItem.endpoint == ($base + "/api/v1/work/items/{id}/claims?runId={runId}") and
  .actions.deleteWorkItem.method == "DELETE" and
  .actions.deleteWorkItem.endpoint == ($base + "/api/v1/work/items/{id}")
' <<<"$AGENT_JSON"

OPENAPI=$(curl -fsS "$BASE/openapi.json")
jq -e '
  .paths["/work/items"].post != null and
  .paths["/work/items/{id}/claims"].post != null and
  .paths["/work/items/{id}/claims"].delete != null and
  .paths["/work/items/{id}/heartbeat"].post != null and
  .paths["/work/items/{id}"].patch != null and
  .paths["/work/items/{id}"].delete != null
' <<<"$OPENAPI"

# Register one fresh agent on this node. Its key owns every mutation below.
CREDS=$(curl -fsS -X POST "$BASE/api/v1/agent/register" \
  -H "content-type: application/json" \
  -d "$(jq -nc --arg name "$RUN_ID" '{name:$name}')")
API_KEY=$(jq -er .apiKey <<<"$CREDS")

# Create one disposable row in this node's store and always clean it up.
ID=""
ID=$(curl -fsS -X POST "$BASE/api/v1/work/items" \
  -H "Authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "type":"task",
    "title":"validation: node-local work-item round trip",
    "summary":"Disposable API validation row; delete after the closed-state assertion."
  }' | jq -er .id)

cleanup() {
  if [ -n "$ID" ]; then
    curl -fsS -X DELETE \
      "$BASE/api/v1/work/items/$ID/claims?runId=$RUN_ID" \
      -H "Authorization: Bearer $API_KEY" >/dev/null 2>&1 || true
    curl -fsS -X DELETE "$BASE/api/v1/work/items/$ID" \
      -H "Authorization: Bearer $API_KEY" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Claim with the node contract's explicit execution identity and command.
curl -fsS -X POST "$BASE/api/v1/work/items/$ID/claims" \
  -H "Authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d "$(jq -nc --arg runId "$RUN_ID" --arg command "$COMMAND" \
    '{runId:$runId,command:$command}')" \
  | jq -e --arg id "$ID" --arg runId "$RUN_ID" --arg command "$COMMAND" \
    '.id == $id and .claimedByRun == $runId and .lastCommand == $command'

# Refresh the same principal-bound claim.
HEARTBEAT_COMMAND="$COMMAND:heartbeat"
curl -fsS -X POST "$BASE/api/v1/work/items/$ID/heartbeat" \
  -H "Authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d "$(jq -nc --arg runId "$RUN_ID" --arg command "$HEARTBEAT_COMMAND" \
    '{runId:$runId,command:$command}')" \
  | jq -e --arg runId "$RUN_ID" --arg command "$HEARTBEAT_COMMAND" \
    '.claimedByRun == $runId and .lastCommand == $command'

# Patch the summary, then patch the terminal state.
curl -fsS -X PATCH "$BASE/api/v1/work/items/$ID" \
  -H "Authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d '{"set":{"summary":"Node-local PATCH readback passed."}}' \
  | jq -e --arg id "$ID" '.id == $id and .summary == "Node-local PATCH readback passed."'

curl -fsS -X PATCH "$BASE/api/v1/work/items/$ID" \
  -H "Authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d '{"set":{"status":"done"}}' >/dev/null

# Independently read back the exact durable item state.
curl -fsS "$BASE/api/v1/work/items/$ID" \
  -H "Authorization: Bearer $API_KEY" \
  | jq -e --arg id "$ID" --arg runId "$RUN_ID" --arg command "$HEARTBEAT_COMMAND" '
      .id == $id and
      .summary == "Node-local PATCH readback passed." and
      .status == "done" and
      .claimedByRun == $runId and
      .lastCommand == $command
    '

# Release the claim through DELETE /claims?runId=, then delete the item.
curl -fsS -X DELETE \
  "$BASE/api/v1/work/items/$ID/claims?runId=$RUN_ID" \
  -H "Authorization: Bearer $API_KEY" \
  | jq -e --arg id "$ID" '.id == $id and .claimedByRun == null'

curl -fsS -X DELETE "$BASE/api/v1/work/items/$ID" \
  -H "Authorization: Bearer $API_KEY" \
  | jq -e --arg id "$ID" '.id == $id and .deleted == true'

# Deletion is part of the proof: the same agent must now read a 404.
trap - EXIT
HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' \
  "$BASE/api/v1/work/items/$ID" \
  -H "Authorization: Bearer $API_KEY")
test "$HTTP_CODE" = "404"
```

## Operator-only work-item sessions — separate contract

The operator currently retains its older PR-oriented coordination contract.
These payloads use `ttlSeconds` / `lastCommand`, not the node-local
`runId` / `command` lease above. Use this section only when `OPERATOR_BASE` is
the operator origin; do not send these payloads to a community node.

```bash
: "${OPERATOR_BASE:?set OPERATOR_BASE to the operator origin}"
: "${OPERATOR_API_KEY:?set OPERATOR_API_KEY to an operator-issued key}"

# Claim while you work
curl -X POST "$OPERATOR_BASE/api/v1/work/items/$ID/claims" \
  -H "Authorization: Bearer $OPERATOR_API_KEY" -H "content-type: application/json" \
  -d '{"ttlSeconds":1800,"lastCommand":"/implement"}'

# Keep the claim fresh
curl -X POST "$OPERATOR_BASE/api/v1/work/items/$ID/heartbeat" \
  -H "Authorization: Bearer $OPERATOR_API_KEY" -H "content-type: application/json" \
  -d '{"ttlSeconds":1800,"lastCommand":"/implement"}'

# Link code artifact
curl -X POST "$OPERATOR_BASE/api/v1/work/items/$ID/pr" \
  -H "Authorization: Bearer $OPERATOR_API_KEY" -H "content-type: application/json" \
  -d '{"branch":"feat/my-change","prNumber":1204}'

# Read current coordination status
curl -H "Authorization: Bearer $OPERATOR_API_KEY" \
  "$OPERATOR_BASE/api/v1/work/items/$ID/coordination"
```

Proof criteria for these routes: claim returns `201`, competing claim returns `200` with `conflict: true`, heartbeat returns `200`, PR link returns `200`, coordination echoes the session, and the durable work item reads back the linked `branch` / `pr`.

## Available graphs (vNext registry)

Graphs are currently discoverable only via session auth (`GET /api/v1/ai/agents`). Machine agents
cannot list graphs via Bearer token yet. Known graphs in the default catalog:

```
langgraph:poet        — poem generation (free, good demo target)
langgraph:brain       — general reasoning + tools
langgraph:research    — web research
langgraph:ponderer    — long-form thinking
langgraph:pr-review   — code review
langgraph:pr-manager  — PR lifecycle management; can inspect CI and merge eligible PRs
langgraph:browser     — browser automation
```

Pass the short name (without `langgraph:` prefix) as `graph_name` in completions requests.

## PR Manager merge delegation

External agents do not need direct write permission to the operator repo to finish a ready node-formation PR. If the parent deployment PR is non-draft, fully green, and the node-formation capacity gate already passed, ask the operator PR Manager graph to inspect and merge it:

```bash
curl -s -X POST $BASE/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "gpt-oss-120b",
    "graph_name": "pr-manager",
    "messages": [{
      "role": "user",
      "content": "Inspect parent deployment PR https://github.com/OWNER/REPO/pull/NUMBER. If it is non-draft, fully green, and the node-formation capacity gate already passed, squash-merge it; otherwise report the exact blocker."
    }]
  }'
```

Do not use this to bypass missing gates. If PR Manager cannot prove eligibility, the correct result is a blocker report, not a manual gitlink edit or a direct GitHub merge by the external agent.

## Full validation flow (agent-first, no browser)

1. **Discover API surface:**
   - `GET /.well-known/agent.json` — confirms `registrationUrl`, `runs`, `runStream`, `completions`.

2. **Register machine actor:**
   - `POST /api/v1/agent/register` with `{ "name": "validator-agent" }`.
   - Persist returned `apiKey`, `userId`, `billingAccountId`. (v0 contract does
     not return `actorId` — the `actors` table does not exist yet and any
     logical actor identifier can be derived from `userId`; see bug.0297 for
     the deferred schema work.)

3. **Execute graph:**
   - `POST /api/v1/chat/completions` with `graph_name` + `Authorization: Bearer <apiKey>`.
   - **ALWAYS use the free model, bare id: `"model": "gpt-oss-120b"`** (the
     LiteLLM `default_free`; zero credits charged, so a fresh self-registered
     key works — no wallet, no top-up). Never a paid model, never a prefixed id
     (`openai/gpt-oss-120b` is rejected upstream and, per bug.5130, surfaces as
     a misleading `insufficient_quota` 429).
   - **`graph_name` is effectively REQUIRED** (e.g. `"poet"` — any
     `NODE_LANGGRAPH_CATALOG` entry). The route's default graph does not exist
     in the catalog (bug.5130), so omitting it 404s with a _model_-blaming
     error. Do not diagnose model problems until you have passed a valid
     `graph_name`.

4. **List runs as machine actor:**
   - `GET /api/v1/agent/runs` with `Authorization: Bearer <apiKey>`.
   - Verify new run appears and `requestedBy == userId`.

5. **Stream run events:**
   - `GET /api/v1/agent/runs/{runId}/stream` with bearer key.
   - Verify SSE events flow and terminal event is received.

6. **Reconnect proof:**
   - Repeat stream call with `Last-Event-ID`; verify replay resumes from cursor.

7. **Write linked knowledge atoms (citation surface):**
   - Prove knowledge **compounds**, not just accumulates. Open one contribution
     and write ≥2 atoms plus ≥1 edge between them — e.g. two `finding`s and a
     `scorecard` that `supports` both.

   ```bash
   # One contribution: 2 finding atoms + a scorecard, then link them.
   CID=$(curl -s -X POST $BASE/api/v1/knowledge/contributions \
     -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
     -d '{"message":"validate cite surface","edits":[
       {"op":"insert","entry":{"id":"val-atom-a","domain":"infrastructure","title":"atom a","content":"...","entryType":"finding"}},
       {"op":"insert","entry":{"id":"val-atom-b","domain":"infrastructure","title":"atom b","content":"...","entryType":"finding"}},
       {"op":"insert","entry":{"id":"val-synth","domain":"infrastructure","title":"synthesis","content":"...","entryType":"scorecard"}},
       {"op":"cite","citingId":"val-synth","citedId":"val-atom-a","citationType":"supports"},
       {"op":"cite","citingId":"val-synth","citedId":"val-atom-b","citationType":"supports"}
     ]}' | jq -r .contributionId)

   # Confirm the rows + their domain landed on the branch.
   curl -s "$BASE/api/v1/knowledge/contributions/$CID/diff" \
     -H "Authorization: Bearer $API_KEY" | jq '.entries[] | {rowId, changeType, domain: (.after.domain)}'
   ```

   - `insert`s must precede the `cite`s that reference them (both resolve on the
     branch). Agents may equivalently use `core__knowledge_write` with a
     `citations` array to write an atom + its outgoing edges in one call.

## Verification stage — what "success" IS (Derek ruling, 2026-09-11)

A node×env is validated ONLY when all three legs hold, each read back from a
system of record — a fast structured error (429/404/504) proves routing, **not
health**; never grade it as a pass:

1. **Successful AI response** — the completion returns real assistant text
   (`choices[0].message.content` non-empty) using the free model
   (`gpt-oss-120b`, bare id) + a valid `graph_name`, from a fresh
   self-registered agent key. ~5–15s is normal; a ~30s edge cut (520) means the
   execution loop is broken (see the 2026-09-11 stale worker-routing incident,
   bug.5121) — and note that heavy parallel probing can starve the 2-pod
   scheduler-worker pool into false 520s, so verify failures sequentially.
2. **Logs** — the request's own marker is retrievable from Loki for the same
   exercise window. ⚠️ As of 2026-09-11 Akash-placed node apps ship NO app logs
   (bug.5127) — until it lands, this leg FAILS fleet-wide and only side-signals
   exist (`service=litellm`, `service=scheduler-worker`, `service=controller`).
   Do not paper over it: record the leg as red.
3. **Langfuse trace** — the completion's trace exists (LiteLLM callbacks →
   `us.cloud.langfuse.com`, per-node attribution via `cogni_node_router`;
   query `/api/public/traces` with the platform keys and match your
   `request_id`/run id). Preflight rejections produce NO trace — absence of a
   trace plus a fast error means the request died app-side.

North star: all three legs readable **via the operator API** (one validation
verb returning response + log marker + trace ref) instead of three credential
planes — track under story.5023/bug.5127.

## Proof criteria

- Agent completes **discover → register → auth → execute → list runs → stream events** with no browser session.
- Node-local work-item validation completes **agent.json/OpenAPI discovery → fresh registration → create → claim → heartbeat → summary patch → `done` patch → exact GET readback → release → delete → `404` readback** against one explicit node `BASE`.
- Graph execution produced a successful run (`status: "success"`).
- Metering path recorded downstream (charge receipt / billing telemetry) for the run.
- **Knowledge compounds:** the linked-atoms contribution diff shows all entries with their `domain`, and a self-referential cite (`citingId === citedId`) is rejected `400`.
- For contribution/API route changes, the live candidate-a call must have a feature-specific Loki marker from the same exercise window. Generic traffic to the pod is not enough for a green validation.

## Configs that matter most

- `AUTH_SECRET` (sign/verify machine keys)
- `REDIS_URL` (run stream replay plane)
- `LITELLM_BASE_URL`, `LITELLM_MASTER_KEY` (usage + provider routing)
- Billing/settlement env from active lane (credit-ledger today, x402 in migration lanes)

## Known shortcomings for next iteration

1. **High**: `graph_name` required on completions for new agents — without it, calls fail with
   "model not found" because no LiteLLM virtual key exists for a freshly registered account.
   Fix: provision a platform virtual key at registration time, or route all completions through
   the graph executor by default.
2. **High**: no machine-accessible graph/agent listing endpoint (`GET /api/v1/ai/agents`
   uses session auth only). Agents cannot self-discover available graphs.
3. **High**: `POST /api/v1/ai/chat` (the primary human chat path) still uses `getSessionUser` —
   Bearer tokens rejected. Agents must use `chat/completions` instead.
4. **High**: no explicit revocation/introspection endpoint for issued machine keys.
5. **Medium**: no first-class "run submit" machine endpoint yet (registration + run read are
   shipped; run create is indirect via chat/completions).
6. Billing strategy transition is in-flight: threshold policy + x402/hyperion split needs a
   single canonical gate (see `proj.x402-e2e-migration`).
7. Eval automation not wired into this flow yet; add canary eval checks so agents can
   self-validate response quality (`proj.ai-evals-pipeline`).
