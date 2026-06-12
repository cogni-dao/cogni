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
verified: 2026-04-08
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
  -d '{"model":"gpt-4o-mini","graph_name":"poet","messages":[{"role":"user","content":"Write a haiku about APIs."}]}'
```

> **Why `graph_name`?** Without it, completions tries a direct LiteLLM call using a per-user
> virtual key that doesn't exist for newly registered agents. Routing via a named graph uses
> the platform key instead. This is a known gap — see shortcomings below.

## Work items — the contribution ledger

Every code change is tied to exactly one work item. **1 work item ≈ 1 PR.** Prefer adopting an existing item over creating one (anti-sprawl). Items stay lean — a one-line `outcome` describing successful E2E validation.

```bash
# Discover open work
curl -H "Authorization: Bearer $API_KEY" \
  "$BASE/api/v1/work/items?statuses=needs_implement,needs_design"

# Create only when nothing fits (server allocates id ≥ 5000)
curl -X POST $BASE/api/v1/work/items \
  -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"type":"task","title":"<short>","node":"operator","summary":"<why>"}'

# PATCH as you progress — every write audited in dolt_log
curl -X PATCH $BASE/api/v1/work/items/$ID \
  -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"set":{"branch":"feat/...","pr":"<url>","status":"needs_merge"}}'
```

**Lifecycle close gate:** PATCH `status=done` only after PR merges to `main`. Pre-merge stays `needs_merge`; rejected review flips back to `needs_implement`.

## Work-item sessions — active execution coordination

Use these routes when an agent is actively working a PR. They are operator-owned coordination surfaces, not shared node primitives.

```bash
# Claim while you work
curl -X POST $BASE/api/v1/work/items/$ID/claims \
  -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"ttlSeconds":1800,"lastCommand":"/implement"}'

# Keep the claim fresh
curl -X POST $BASE/api/v1/work/items/$ID/heartbeat \
  -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"ttlSeconds":1800,"lastCommand":"/implement"}'

# Link code artifact
curl -X POST $BASE/api/v1/work/items/$ID/pr \
  -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"branch":"feat/my-change","prNumber":1204}'

# Read current coordination status
curl -H "Authorization: Bearer $API_KEY" \
  $BASE/api/v1/work/items/$ID/coordination
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
langgraph:browser     — browser automation
```

Pass the short name (without `langgraph:` prefix) as `graph_name` in completions requests.

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
   - Use `"model": "gpt-4o-mini"` (free, no wallet needed for local dev).

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

## Proof criteria

- Agent completes **discover → register → auth → execute → list runs → stream events** with no browser session.
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
