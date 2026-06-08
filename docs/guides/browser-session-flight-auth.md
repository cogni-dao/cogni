---
id: guide.browser-session-flight-auth
type: guide
title: Browser-Session Flight Auth
status: draft
trust: draft
summary: Production browser-session setup for approving an AI developer and requesting candidate-a nodeRef flights.
read_when: Guiding a node creator through production auth so an AI developer can flight a creator-owned node.
owner: derekg1729
created: 2026-06-08
verified: 2026-06-08
tags: [auth, rbac, candidate-a, node-flight]
---

# Browser-Session Flight Auth

Use this when a node creator needs to authorize an AI developer to flight that
creator-owned node through the production operator API.

This is a production session flow. The captured session file grants the same
operator privileges as the signed-in browser user. Keep it under `.local-auth/`,
never commit it, and delete it when the flight window is over if the agent no
longer needs it.

## What This Proves

The live flight contract is source-addressed:

```json
{
  "nodeRef": {
    "nodeId": "<node_id>",
    "sourceSha": "<child_repo_main_sha>"
  }
}
```

`prNumber` is not the deploy identity for externally built node artifacts.

When OpenFGA is configured, ownership alone is not the flight gate. The node
creator/admin must grant `node.flight` authority by approving the registered AI
developer. Approval writes:

```text
node:<node_id>#developer@user:<agent_user_id>
```

The subsequent flight request checks `node.flight` on `node:<node_id>` before
GitHub prepare/dispatch.

## Inputs

Collect these before touching auth:

| Name            | Source                                                                       |
| --------------- | ---------------------------------------------------------------------------- |
| `NODE_ID`       | `nodes/<slug>/.cogni/repo-spec.yaml` or the operator launch pack             |
| `SOURCE_SHA`    | child node repo `main` commit that produced the `sha-<SOURCE_SHA>` image tag |
| `AGENT_USER_ID` | `userId` returned by `POST /api/v1/agent/register` on the operator API       |
| `AGENT_API_KEY` | `apiKey` returned by that same registration call                             |

## 1. Register The AI Developer

Run this against production operator from the AI developer workspace:

```bash
BASE=https://cognidao.org

CREDS="$(
  curl -fsS -X POST "$BASE/api/v1/agent/register" \
    -H "Content-Type: application/json" \
    -d '{"name":"node-flight-agent"}'
)"

AGENT_USER_ID="$(printf '%s' "$CREDS" | jq -r .userId)"
AGENT_API_KEY="$(printf '%s' "$CREDS" | jq -r .apiKey)"
printf 'AGENT_USER_ID=%s\n' "$AGENT_USER_ID"
```

Do not paste `AGENT_API_KEY` into chat. Keep it in the shell or a gitignored
local env file.

## 2. Capture The Creator Session

Use the same CDP profile pattern as
[`candidate-auth-bootstrap.md`](./candidate-auth-bootstrap.md), but capture the
production operator session:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$PWD/.local-auth/chrome-profile"
```

In that Chrome profile, open `https://cognidao.org`, sign in with the node
creator wallet, and leave the signed-in tab open. Then from the operator repo:

```bash
node scripts/dev/capture-authed-state.mjs production-operator https://cognidao.org
```

This writes `.local-auth/production-operator.storageState.json`.

## 3. Approve The AI Developer

Build a cookie header from the captured creator session:

```bash
COOKIE_HEADER="$(
  node -e '
    const fs = require("fs");
    const state = JSON.parse(fs.readFileSync(".local-auth/production-operator.storageState.json", "utf8"));
    console.log(state.cookies.map((c) => `${c.name}=${c.value}`).join("; "));
  '
)"
```

Approve the registered AI developer for exactly one node:

```bash
curl -fsS -X POST "https://cognidao.org/api/v1/nodes/$NODE_ID/developers" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE_HEADER" \
  -d "{\"agentUserId\":\"$AGENT_USER_ID\",\"decision\":\"approve\"}" | jq .
```

Expected response:

```json
{
  "nodeId": "<node_id>",
  "agentUserId": "<agent_user_id>",
  "decision": "approve"
}
```

If this returns `503 authz_unavailable`, the OpenFGA substrate is not active for
the operator pod. Fix the substrate before retrying; do not bypass RBAC.

## 4. Request Candidate-A Flight

The AI developer requests the flight with its bearer token:

```bash
curl -fsS -X POST https://cognidao.org/api/v1/vcs/flight \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENT_API_KEY" \
  -d "{\"nodeRef\":{\"nodeId\":\"$NODE_ID\",\"sourceSha\":\"$SOURCE_SHA\"}}" | jq .
```

Expected result is `202` with candidate-flight dispatch metadata.

Failure meanings:

| Error                              | Meaning                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `authz_denied`                     | The OpenFGA developer tuple is missing or wrong for this node               |
| `authz_unavailable`                | OpenFGA or config is unavailable; fail closed                               |
| `node-ref flight preflight failed` | source commit, repo-spec identity, parent pin, or image tag is not valid    |
| `workflow_not_found`               | operator GitHub workflow config is broken or dispatched from the wrong repo |

## 5. Validate The Flight

After `candidate-flight.yml` succeeds, prove the deployed artifact identity:

```bash
curl -fsS "https://<slug>-test.cognidao.org/version" | jq .
```

`buildSha` must equal `SOURCE_SHA`. Then run
[`/validate-candidate`](../../.claude/skills/validate-candidate/SKILL.md)
against the node's candidate URL and include feature-specific Loki evidence in
the scorecard.

## Cleanup

To revoke the AI developer's node flight authority:

```bash
curl -fsS -X POST "https://cognidao.org/api/v1/nodes/$NODE_ID/developers" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE_HEADER" \
  -d "{\"agentUserId\":\"$AGENT_USER_ID\",\"decision\":\"reject\"}" | jq .
```

Delete `.local-auth/production-operator.storageState.json` when the agent no
longer needs creator-session access.

## Related

- [RBAC](../spec/rbac.md)
- [Identity Model](../spec/identity-model.md)
- [CI/CD](../spec/ci-cd.md)
- [Agent-First API Validation](./agent-api-validation.md)
- [Candidate Auth Bootstrap](./candidate-auth-bootstrap.md)
