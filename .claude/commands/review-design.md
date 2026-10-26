Run /review-design for: #$ITEM

Keep #$ITEM bound to the current node; preserve all invocation arguments.
Read the complete owning procedure:

```bash
set -euo pipefail
set -a
source "$(git rev-parse --show-toplevel)/.env.cogni"
set +a
: "${COGNI_NODE_API_KEY:?saved operator credential required}"
body=$(curl -fsS --max-time 20 --retry 1 \
  -H "Authorization: Bearer $COGNI_NODE_API_KEY" \
  "https://cognidao.org/api/v1/knowledge/review-design")
printf '%s\n' "$body" | jq -er '.content | select(type == "string" and length > 0)'
```

Use the saved operator credential above; never forward a sovereign node bearer.
Read required dependencies in full when the procedure requires their action.
If credentials, retrieval, content or a required dependency fails, stop that
stage and record the failed gate on the node-local item; repair it before acting.
