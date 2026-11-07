---
name: dns-ops
description: "DNS operations for Cogni multi-node infrastructure. Node app DNS is automatic (do NOT hand-set it); this skill covers DNS trust boundaries, one-time Cloudflare zone setup, the env apex record, removing a purged node's record, and protected-record safety. Use it whenever a test fleet, Akash workload, Cloudflare token, domain, zone, or node hostname is being created or changed."
---

# DNS Operations

The hub owns this knowledge. Read it from the current node with the saved key:

```bash
curl -fsS -H "Authorization: Bearer $COGNI_NODE_API_KEY" "https://cognidao.org/api/v1/knowledge/<id>"
```

Read each response's `content`, in this order:

1. `node-dns-operations` — who writes each record, the zone trust boundary, zone setup, the env apex, removing a stale record, protected records, troubleshooting.
2. `test-fleet-parity-boundary` — when the change touches the test fleet or `cogni-testing.org`.
3. `deploy-a-declared-workload` — when a node host is involved: the sequencer moves the edge.

Never hand-make or `curl`-upsert a node host record. Never change `@`, `www` or MX from code.

If a fetch fails, stop and report it. Do not act on an error body or on memory.
