---
name: vm-health
description: Graded health snapshot of every shared Cogni VM (production, preview, candidate-a) against the ONE reliability policy — GREEN/YELLOW/RED/UNKNOWN verdict, named memory consumers, next action. Use FIRST when asked "is prod healthy", "why is the fleet flapping", "is the VM overloaded / swapping / out of disk", "what is eating memory", "should we resize", or "did the fix work". Read-only; never SSH to answer these. The contract lives in the operator knowledge hub.
---

# vm-health

> The contract lives in the hub, not here. This file is only the trigger.

Fetch and follow the [vm-health-snapshot skill](https://cognidao.org/knowledge/vm-health-snapshot) before answering VM health questions:

```bash
# COGNI_NODE_API_KEY is the saved node-agent key from .env.cogni.
curl -fsS --max-time 20 -H "Authorization: Bearer $COGNI_NODE_API_KEY" \
  https://cognidao.org/api/v1/knowledge/vm-health-snapshot | jq -er .content
```

The executable tool is `node scripts/vm-health-snapshot.mjs [env ...] [--json]`. It owns no thresholds: it grades the recorded `cogni_reliability_v1_*` series against `packages/node-contracts/src/reliability-policy.v1.json`, the same contract the operator `/api/v1/nodes/{id}/observability/health` route uses. If the hub entry is not published, run the tool and report its verdict lines verbatim. Do not invent thresholds.
