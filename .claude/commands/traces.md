It's time to collect and analyze Langfuse traces for the problem at hand.

Use current context to infer the environment, or get user input: #$PROBLEM

This command is the trace counterpart to `logs.md`: operator agents may use
Langfuse directly when they hold operator credentials; node developers should
use the operator proxy so they never receive the shared Langfuse key.

## 1. Identify the Environment

Ask the user which environment to investigate, or infer from context:

- **local** - local app/container trace wiring
- **candidate-a** - candidate slot
- **preview** - preview deployment
- **production** - live production

Operator direct access reads `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, and
`LANGFUSE_SECRET_KEY` from the environment. Production currently uses
`https://us.cloud.langfuse.com`; the default `https://cloud.langfuse.com` may be
the wrong project.

## 2. Node Developer Trace Proxy

A node developer debugging only their node does not use Langfuse credentials.
They call the operator proxy with their Cogni API key and a developer grant on
that node:

```bash
OP=https://cognidao.org
NODE=beacon                 # slug or repo-spec node_id
KEY=$COGNI_API_KEY_PROD     # principal with node developer access

curl -fsS "$OP/api/v1/nodes/$NODE/observability/traces?limit=10" \
  -H "Authorization: Bearer $KEY" \
  | jq '.traces[] | {id,timestamp,name,tags,nodeId}'
```

The operator resolves `{slug|node_id}` against the registry, checks the same
developer tuple as flight/logs (`node.flight`), then reads Langfuse with the
operator-held key pinned to `tags=<nodeId>`. The developer never receives a
Langfuse credential.

Expected list shape:

```json
{
  "nodeId": "f97f68f2-8406-4a3b-b5a9-d579b779f19d",
  "traces": [
    {
      "id": "b3c168283622795df50702e1fb3bea70",
      "name": "graph-execution",
      "timestamp": "2026-06-29T03:30:10.479Z",
      "tags": [
        "f97f68f2-8406-4a3b-b5a9-d579b779f19d",
        "langgraph",
        "langgraph:brain"
      ],
      "nodeId": "f97f68f2-8406-4a3b-b5a9-d579b779f19d"
    }
  ]
}
```

### Trace Detail

The list endpoint proves node attribution and gives trace ids. To inspect the
payload, use the node-scoped detail proxy once available:

```bash
TRACE=b3c168283622795df50702e1fb3bea70

curl -fsS "$OP/api/v1/nodes/$NODE/observability/traces/$TRACE" \
  -H "Authorization: Bearer $KEY" \
  | jq '{id,timestamp,name,tags,nodeId,metadata,input,output}'
```

The detail proxy must enforce the same node boundary defense-in-depth as the
list proxy: after fetching the trace from Langfuse, the operator returns content
only when the trace is tagged with the resolved node id or carries matching
`metadata.nodeId`. A mismatch returns `404`; it must not leak another node's
trace content.

## 3. Operator Direct Langfuse Read

Use this only when you are operating as the operator and already hold the shared
Langfuse project credential. This bypasses the developer proxy and can see the
whole project, so do not hand these keys to node developers.

```bash
set -a
. ./.env.production
set +a

NODE_ID=f97f68f2-8406-4a3b-b5a9-d579b779f19d

curl -fsS -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "$LANGFUSE_BASE_URL/api/public/traces?limit=3&tags=$NODE_ID" \
  | jq '.data[] | {id,timestamp,name,tags,metadata}'
```

Fetch a full trace payload:

```bash
TRACE=b3c168283622795df50702e1fb3bea70

curl -fsS -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "$LANGFUSE_BASE_URL/api/public/traces/$TRACE" \
  | jq '{id,timestamp,name,tags,metadata,input,output}'
```

## 4. Interpret Failures

| Status                             | Meaning                                                                | Next step                                                     |
| ---------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| `401 unauthorized`                 | Missing or invalid Cogni bearer/session for the operator proxy.        | Use the right env key/session.                                |
| `403 authz_denied`                 | Authenticated principal lacks developer access for the node.           | Request/approve node developer access.                        |
| `404 node_not_found`               | `{slug                                                                 | node_id}` does not resolve in operator registry.              | Check the node slug and repo-spec `node_id`. |
| `404 trace_not_found`              | Detail read either does not exist or is not attributable to that node. | List traces first; verify the trace id belongs to the node.   |
| `503 observability_unwired`        | Operator env lacks Langfuse reader secrets.                            | Fix OpenBao/ESO for that env.                                 |
| `502 observability_upstream_error` | Langfuse API failed or timed out upstream.                             | Retry once, then check operator logs for the terminal marker. |
| `200` with `traces: []`            | No node-tagged traces matched.                                         | Generate a fresh graph run and omit optional filters.         |

## 5. Loki Proof Marker

Every proxy read emits a terminal marker without trace content:

```logql
{namespace="cogni-production",pod=~"operator-node-app-.*"} |~ "feature.node_observability_traces.complete"
```

Use Loki to prove the proxy request reached the operator and how it terminated.
Use Langfuse, through the proxy, for trace payload.

## 6. Synthesize and Analyze

After collecting traces, provide:

1. **Trace IDs:** latest relevant trace ids and timestamps
2. **Attribution:** nodeId, graph tag, model, runId/reqId
3. **I/O:** user input and assistant output when available through detail
4. **Outcome:** status, finish reason, token usage
5. **Scope:** whether evidence came from node proxy or operator direct Langfuse
6. **Next Steps:** missing grants, wiring fixes, or code changes
