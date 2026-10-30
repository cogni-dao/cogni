---
id: agent-api-validation-guide
type: guide
title: Agent API Validation (Local and Candidate)
status: draft
trust: draft
summary: Exercise the target node's current authenticated API and distinguish startup, execution, billing, and behavior proof.
read_when: Validating a local or candidate HTTP/API surface through a machine-agent identity.
owner: derekg1729
created: 2026-04-08
verified: 2026-10-29
tags: [agent-api, validation, candidate-a, billing]
---

# Agent API Validation (Local and Candidate)

Use the target node's current discovery, source contracts and issued identity. Operator
coordination, sovereign lease releases and graph catalogs differ by node and version.
Do not treat an old payload or a successful HTTP status as proof of the whole flow.

For local startup, use that checkout's README and environment example. The
merged [local development guide](https://cognidao.org/knowledge/local-agent-development)
owns the shared startup and iteration journey. This repository guide owns route
exercises, not the full shipping lifecycle or proof that a model's answer is useful.

Before candidate validation, load
[validate-candidate](https://cognidao.org/knowledge/validate-candidate). For an agent
behavior change, also load the
[agent evaluation loop](https://cognidao.org/knowledge/agent-evaluation-loop).
Respect the session's local command and model-spend budgets.

## 1. Discover the target and reuse its identity

Set BASE explicitly to the local app or authorized candidate. Never fall back to a
production host or reuse another node's credentials.

```bash
: "${BASE:?set the target app origin}"
mkdir -p .context
curl -fsS "$BASE/.well-known/agent.json" > .context/agent-discovery.json
curl -fsS "$BASE/openapi.json" > .context/agent-openapi.json
```

Create .context first. These reads do not mutate the target. Discovery/OpenAPI are
bounded projections: an omitted operation does not prove the route is absent. Inspect
the target revision's executable contract before sending an unadvertised mutation.

Reuse a saved identity issued by this target. For a first local setup only:

```bash
umask 077
mkdir -p .context
if [ ! -s .context/local-dev-identity.json ]; then
  curl -fsS -X POST "$BASE/api/v1/agent/register" \
    -H 'content-type: application/json' \
    -d '{"name":"local-agent-validation"}' > .context/local-dev-identity.json
fi
API_KEY=$(jq -er .apiKey .context/local-dev-identity.json)
```

Keep credentials private. Record the returned userId and billingAccountId without
printing the key. Registration on a local app grants no deployed operator authority.
A candidate uses its own saved identity and node grants; do not borrow human sessions.

## 2. Discover a graph and model, then exercise stateful chat

The inspected operator routes accept the normal Bearer identity for graph discovery,
model discovery and ai/chat. Check the current target before generalizing to an older
sovereign release.

```bash
curl -fsS "$BASE/api/v1/ai/agents" \
  -H "Authorization: Bearer $API_KEY" > .context/agent-catalog.json
curl -fsS "$BASE/api/v1/ai/models" \
  -H "Authorization: Bearer $API_KEY" > .context/model-catalog.json
```

Select an exposed agentId and the full model ref from these results. Confirm model
spend is authorized. A gateway model that costs the app zero credits can still require
funded upstream service. Do not silently substitute models or claim registration
provides a provider budget.

For LangGraph dev, set LANGGRAPH_DEV_URL before starting the app and use stateful
ai/chat. The app schema accepts message, modelRef, graphName and an optional stateKey.
The server returns X-State-Key for conversation continuity.

```bash
: "${GRAPH_NAME:?set an exposed agentId}"
: "${MODEL_REF:?set the selected model ref as JSON}"
STATE_KEY=local_validation_1
jq -n --arg graph "$GRAPH_NAME" --arg state "$STATE_KEY" \
  --argjson model "$MODEL_REF" \
  '{message:"Say hello.",modelRef:$model,graphName:$graph,stateKey:$state}' \
  > .context/chat-request.json
curl -N -sS --fail-with-body -X POST "$BASE/api/v1/ai/chat" \
  -D .context/chat-response.headers \
  -H "Authorization: Bearer $API_KEY" -H 'content-type: application/json' \
  --data-binary @.context/chat-request.json > .context/chat-response.sse
```

Read the complete assistant output, terminal stream and saved result. HTTP 200, an
empty reply, a structured error or Studio registration alone is not execution proof.
Choose a new safe stateKey for a new case; reuse the returned key for the same
conversation. Capture failures as well as successes.

### Completions and billing are separate questions

The OpenAI-compatible completions route has a different input shape: model,
graph_name and messages. Its old example omitted the conversation state required by
the development provider. Use ai/chat above for the local app path.

Omitting graph_name does not select a direct LiteLLM bypass. The facade selects a
default graph, whose existence depends on the catalog. Selecting a graph does not
switch from a missing per-user gateway key to platform authority. Investigate a 429
using its actual credit/rate-limit evidence. Follow the
[billing-routing contract](https://cognidao.org/knowledge/litellm-authenticated-workload-routing).

## 3. Read the existing run and recover delivery

Use the run ID from this request and the same principal. Follow discovery's run-list
and stream paths, normally /api/v1/agent/runs and
/api/v1/agent/runs/{runId}/stream. Check the owned run's actual terminal outcome.
Read the owned conversation through the target's thread API when available.

Reconnect with the stream's Last-Event-ID cursor and verify the expected suffix.
After a client timeout, inspect the existing run and saved conversation before
considering another submit. Do not replay ai/chat as output recovery. A lost socket
can outlive successful execution, while submit replay can create duplicate run cards.
See [run lifecycle](https://cognidao.org/knowledge/agent-run-lifecycle).

## 4. Exercise work-item coordination only within scope

Read [work-item fields](https://cognidao.org/knowledge/work-item-field-reference), the
target discovery schemas and the current revision. Normal delivery owns exactly one
work item. Use rankScore and live coordination when selecting autonomous work; a
legacy claim field does not establish a live session.

On the operator, current coordination payloads use ttlSeconds and lastCommand:

```bash
: "${ID:?set the owned work item}"
curl -fsS "$BASE/api/v1/work/items/$ID/coordination" \
  -H "Authorization: Bearer $API_KEY"
# When claiming this item is within scope:
curl -fsS -X POST "$BASE/api/v1/work/items/$ID/claims" \
  -H "Authorization: Bearer $API_KEY" -H 'content-type: application/json' \
  -d '{"ttlSeconds":1800,"lastCommand":"/validate-candidate"}'
curl -fsS -X POST "$BASE/api/v1/work/items/$ID/heartbeat" \
  -H "Authorization: Bearer $API_KEY" -H 'content-type: application/json' \
  -d '{"ttlSeconds":1800,"lastCommand":"/validate-candidate"}'
```

Verify claimed=true and conflict=false, then read the current session. Operator PR
linking uses POST /work/items/{id}/pr with branch/prNumber. Do not send these payloads
to a sovereign node unless its current schema matches.

Sovereign releases can expose a different runId/command lease protocol, including
token-based v2 operations. Prove the exact lease owner and revision from that node.
Never assume DELETE /claims or DELETE /items exists. Use only its supported
release/cancel operation. Do not copy the retired v1 delete round trip into a v2 node.

For an explicitly authorized disposable fixture, prove create, claim, heartbeat,
compare-and-set patch, exact body readback and supported cleanup. Preserve existing
rows. Never mark a real contribution done before merge. A fixture must be clearly
labelled and governed by its target's lifecycle rules.

## 5. Exercise knowledge only when requested

Follow [knowledge contribution flow](https://cognidao.org/knowledge/knowledge-contribution-flow).
Use one focused contribution, a registered domain and a concrete useWhen. If citation
behavior is in scope, use the smallest agreed fixtures and an edge that supports an
actual claim. Read the full diff back. A self-edge must reject. Do not invent several
durable atoms just to inflate a validation count. Close your disposable inbox through
the supported owner operation. A session human merges real knowledge.

## 6. Assemble independent proof

- Startup: pnpm dev:verify checks and skips. It makes no model call. The operator
  requires local knowledge/work fixtures for its full-body checks; standalone
  versions can skip empty-store body checks. Skips do not prove body access.
- Execution: complete assistant answer plus the owned run's terminal result.
- Billing: an accepted normal receipt and native provider usage correlated to the
  node/account and run/request. A skipped receipt or free response is insufficient.
- Logs: the request's correlated marker from the actual app/worker/gateway window.
  Use [node log access](https://cognidao.org/knowledge/node-service-logs-read) for
  deployed targets. Do not substitute a historical claim that all fleet logs are absent.
- Traces: actual native observations for the same node, lane and IDs. Follow
  [node trace access](https://cognidao.org/knowledge/node-ai-traces-read); do not hand
  developers platform Grafana or Langfuse credentials. A configured key is not a trace.
- Persistence/replay: observe the same saved conversation/run after a normal restart
  and independently verify cursor replay. This is separate from readiness.
- Behavior: compare a bounded case and passing control under the agent evaluation
  guide. Transport success and schema validity do not certify answer quality.

Use source/build identities and report unexercised surfaces explicitly. This guide
was reconciled against current source; it does not claim a new local or candidate
runtime test. Full code delivery still follows independent review, CI, operator
flight, candidate validation and operator merge. PR Manager chat is not an alternate
merge authority; use the current operator delivery contract.
