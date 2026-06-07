---
name: flight-candidate
description: Dispatch a Cogni candidate-a flight through the operator API for either a monorepo PR number or an external spawned nodeRef, using the repo-local .env.cogni bearer token. Use when an agent needs to call POST /api/v1/vcs/flight, flight PRs, flight node refs, or explain exact shell commands for candidate flight dispatch.
---

# flight-candidate

Dispatch candidate-a through the operator API. Do not use `gh workflow run candidate-flight.yml`; the production operator endpoint is the auditable path for external agents.

## Environment

Use the repo root. This skill assumes `.env.cogni` exists and contains the operator API keys:

- `COGNI_API_KEY_PROD`
- `COGNI_API_KEY_TEST`
- optional Grafana vars for debugging flight request logs

Source it without printing secrets:

```bash
set -euo pipefail
set -a
source .env.cogni
set +a
```

Default to production for real external-agent flighting:

```bash
BASE="https://cognidao.org"
AUTH_HEADER="Authorization: Bearer ${COGNI_API_KEY_PROD}"
```

Use candidate only when deliberately testing the candidate operator itself:

```bash
BASE="https://test.cognidao.org"
AUTH_HEADER="Authorization: Bearer ${COGNI_API_KEY_TEST}"
```

## Flight A PR

Use this for a monorepo PR after the relevant PR build checks are green enough for the operator gate:

```bash
set -euo pipefail
set -a
source .env.cogni
set +a

curl -sS -X POST "https://cognidao.org/api/v1/vcs/flight" \
  -H "Authorization: Bearer ${COGNI_API_KEY_PROD}" \
  -H "content-type: application/json" \
  -d '{"prNumber":1561}' \
  -w '\nHTTP_STATUS:%{http_code}\n'
```

Candidate-operator fallback:

```bash
set -euo pipefail
set -a
source .env.cogni
set +a

curl -sS -X POST "https://test.cognidao.org/api/v1/vcs/flight" \
  -H "Authorization: Bearer ${COGNI_API_KEY_TEST}" \
  -H "content-type: application/json" \
  -d '{"prNumber":1561}' \
  -w '\nHTTP_STATUS:%{http_code}\n'
```

Expected success is HTTP `202` with JSON containing `dispatched: true`, `slot: "candidate-a"`, `workflowUrl`, and the PR `headSha`.

## Flight A Node Ref

Use this for an external spawned node-template repo build. `nodeId` is the operator DB UUID for the registered node. `sourceSha` is the 40-character commit SHA in that node's source repo. The operator validates the node catalog row, source commit, repo-spec node id, and immutable GHCR image tag before dispatching.

```bash
set -euo pipefail
set -a
source .env.cogni
set +a

NODE_ID="4ff8eac1-4eba-4ed0-931b-b1fe4f64713d"
SOURCE_SHA="0123456789abcdef0123456789abcdef01234567"

curl -sS -X POST "https://cognidao.org/api/v1/vcs/flight" \
  -H "Authorization: Bearer ${COGNI_API_KEY_PROD}" \
  -H "content-type: application/json" \
  -d "{\"nodeRef\":{\"nodeId\":\"${NODE_ID}\",\"sourceSha\":\"${SOURCE_SHA}\"}}" \
  -w '\nHTTP_STATUS:%{http_code}\n'
```

Equivalent `jq` form, safer when values come from shell variables:

```bash
set -euo pipefail
set -a
source .env.cogni
set +a

NODE_ID="4ff8eac1-4eba-4ed0-931b-b1fe4f64713d"
SOURCE_SHA="0123456789abcdef0123456789abcdef01234567"

jq -n --arg nodeId "$NODE_ID" --arg sourceSha "$SOURCE_SHA" \
  '{nodeRef:{nodeId:$nodeId,sourceSha:$sourceSha}}' |
curl -sS -X POST "https://cognidao.org/api/v1/vcs/flight" \
  -H "Authorization: Bearer ${COGNI_API_KEY_PROD}" \
  -H "content-type: application/json" \
  -d @- \
  -w '\nHTTP_STATUS:%{http_code}\n'
```

Candidate-operator `jq` fallback:

```bash
set -euo pipefail
set -a
source .env.cogni
set +a

NODE_ID="4ff8eac1-4eba-4ed0-931b-b1fe4f64713d"
SOURCE_SHA="0123456789abcdef0123456789abcdef01234567"

jq -n --arg nodeId "$NODE_ID" --arg sourceSha "$SOURCE_SHA" \
  '{nodeRef:{nodeId:$nodeId,sourceSha:$sourceSha}}' |
curl -sS -X POST "https://test.cognidao.org/api/v1/vcs/flight" \
  -H "Authorization: Bearer ${COGNI_API_KEY_TEST}" \
  -H "content-type: application/json" \
  -d @- \
  -w '\nHTTP_STATUS:%{http_code}\n'
```

Expected success is HTTP `202` with JSON containing `nodeRef.slug`, `nodeRef.sourceRepo`, `nodeRef.image`, `slot: "candidate-a"`, and `workflowUrl`.

## Failure Reads

- `401 {"error":"Session required"}`: wrong key for that API base or a bearer-token auth regression on the deployed operator. Real external-agent flighting should use `COGNI_API_KEY_PROD` against `https://cognidao.org`; candidate-operator testing should use `COGNI_API_KEY_TEST` against `https://test.cognidao.org`.
- `422 ci_not_green`: the operator refused PR flight because pending or failed PR checks remain.
- `500` from the route: inspect candidate logs before retrying. One known config failure is `GitHub App not installed on Cogni-DAO/cogni`, which means the running operator deploy plane cannot access the repo installation.

For quick log inspection:

```bash
COGNI_ENV_FILE=.env.candidate-a scripts/loki-query.sh \
  '{env="candidate-a",service="app",pod=~"operator-node-app-.*"} | json | route="vcs.flight"' \
  20 50 | jq -r '.data.result[]?.values[]?[1]'
```

## After Dispatch

Watch the PR for a `candidate-flight` check on the exact head SHA. Once it is green and `/version` serves that SHA, immediately run the next skill:

```text
/validate-candidate <PR_NUMBER>
```
