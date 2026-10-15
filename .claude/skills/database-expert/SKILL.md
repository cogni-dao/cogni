---
name: database-expert
description: Cogni database architecture and operations. Use for PostgreSQL environment residency, database-per-node boundaries, secret custody versus data placement, shared/dedicated cells, noisy neighbors, role/pool budgets, DATABASE_URL or DOLTGRES_URL, migrations, backups, restore proof, database health, and database knowledge drift. The executable contract lives in the operator knowledge hub.
---

# database-expert

> The contract lives in the hub, not here. This file is only the trigger.

Fetch and follow the [database expert skill](https://cognidao.org/knowledge/database-expert) before database work:

```bash
# COGNI_NODE_API_KEY is the saved node-agent key from .env.cogni.
curl -fsS --max-time 20 -H "Authorization: Bearer $COGNI_NODE_API_KEY" \
  https://cognidao.org/api/v1/knowledge/database-expert | jq -er .content
```

That skill routes to the owning specs, contracts, and knowledge atoms. If recall fails or the entry is not published, report the unavailable skill and stop database operations; do not substitute a stale local manual or an unmerged proposal.
