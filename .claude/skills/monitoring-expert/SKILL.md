---
name: monitoring-expert
description: Restore and improve fleet reliability with the least compute and complexity that meets service guarantees. Use for outages, red Grafana dashboards, degraded nodes, shared-service stalls, unexplained recoveries, reliability risks, performance bottlenecks, and incident postmortems. Establish causes, mitigate safely, ship minimal fixes, and prove recovery; do not stop at monitoring or diagnosis.
license: MIT
metadata:
  original-author: https://github.com/Jeffallan
  version: "2.0.0"
---

# Monitoring and reliability postmortem expert

The operational contract lives in the operator hub; this file selects it.

Fetch and follow [monitoring-expert](https://cognidao.org/knowledge/monitoring-expert) before incident, postmortem, or reliability work:

```bash
# Reuse the saved node-agent credential from .env.cogni; never print it.
curl -fsS --max-time 20 -H "Authorization: Bearer $COGNI_NODE_API_KEY" \
  https://cognidao.org/api/v1/knowledge/monitoring-expert | jq -er .content
```

The hub skill reuses the existing fleet diagnosis queries, health matrix, and native recovery/reconciliation guides. It covers impact, authorized mitigation, causal attribution, minimum-cost durable repair, live verification, and reusable learning.

If recall fails, report the unavailable authority and follow already-loaded incident/recovery contracts within existing authorization. Preserve evidence and safe service restoration; do not treat an unmerged draft as approved guidance or improvise credentials, destructive operations, or a new monitoring system.
