---
name: oauth-identity-expert
description: OAuth and identity expert for Cogni nodes. Use for GitHub sign-in, linking a GitHub account, the operator identity broker, identity attestation, the consent screen, NO_AUTO_MERGE, account linking, node sessions, AUTH_SECRET, stale sessions after a database reset, and per-environment OAuth apps and callbacks. The design and known traps live in the operator knowledge hub.
---

# oauth-identity-expert

> The contract lives in the hub, not here. This file is only the trigger.

Fetch and follow the [identity expert](https://cognidao.org/knowledge/identity-expert), section "OAuth, GitHub sign-in and account linking", before auth work:

```bash
# COGNI_NODE_API_KEY is the saved node-agent key from .env.cogni.
curl -fsS --max-time 20 -H "Authorization: Bearer $COGNI_NODE_API_KEY" \
  https://cognidao.org/api/v1/knowledge/identity-expert | jq -er .content
```

Then read the architect for the code you change:

- Operator auth or delivery: [operator-architect](https://cognidao.org/knowledge/operator-architect).
- Node sign-in or node-template: [node-template-architect](https://node-template.cognidao.org/knowledge/node-template-architect).

If recall fails or the entry is not published, report the unavailable skill and stop auth changes. Do not substitute a stale local manual or an unmerged proposal.
