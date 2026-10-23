Run /design for: #$ITEM

This command is a harness entry point. The operator hub owns its procedure.
Resolve #$ITEM against the workspace's bound node. If absent, reuse the owned
work item; otherwise select and claim one through that node's discovered work
API before acting. Read its outcome, coordination and applicable repo rules.
Work-item reads/writes and node-owned knowledge stay on the bound node.

Read the complete shared delivery guide, then the stage procedure:

```bash
set -euo pipefail
set -a
source "$(git rev-parse --show-toplevel)/.env.cogni"
set +a
: "${COGNI_NODE_API_KEY:?saved operator credential required}"
for entry in cicd-e2e-required-sequence lifecycle-design; do
  body=$(curl -fsS --max-time 20 --retry 1 \
    -H "Authorization: Bearer $COGNI_NODE_API_KEY" \
    "https://cognidao.org/api/v1/knowledge/$entry")
  printf '%s\n' "$body" | jq -er '.content | select(type == "string" and length > 0)'
done
```

Read each required dependency named by those bodies in full before its action.
The credential above belongs to the operator source; never forward a sovereign
node bearer to it. Preserve the invocation arguments throughout the handoff.
If a credential, fetch, body or required dependency fails, stop the stage,
record the failed retrieval gate on the owned item and repair it. Do not use an
index, cached summary, error response or retired repository procedure instead.
