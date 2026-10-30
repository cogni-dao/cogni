---
name: finances-expert
description: Cogni finances and runway. Use whenever money can stop the fleet or an agent: Akash Console credit and escrow, OpenRouter/LLM credits, system-tenant credits, Cherry or other vendor bills, operator/steward/DAO treasury wallets, burn rate, runway days, top-ups, auto-reload, "who pays for X", "will we run out", "insufficient_funds", 402 payment_required, insufficient_credits, or a paid resource dying for no apparent reason. Inbound user-credit purchases route to payments-expert. The executable contract lives in the operator knowledge hub.
---

# finances-expert

> The contract lives in the hub, not here. This file is only the trigger.

Fetch and follow the [finances expert skill](https://cognidao.org/knowledge/finances-expert) before money work:

```bash
# COGNI_NODE_API_KEY is the saved node-agent key from .env.cogni.
curl -fsS --max-time 20 -H "Authorization: Bearer $COGNI_NODE_API_KEY" \
  https://cognidao.org/api/v1/knowledge/finances-expert | jq -er .content
```

First read of any money question, keyless and read-only:

```bash
node scripts/money-plane-snapshot.mjs   # exit 0 GREEN · 1 YELLOW · 2 RED/UNKNOWN
```

If recall fails or the entry is not published, report the unavailable skill and stop; do not substitute a stale local manual or an unmerged proposal.
