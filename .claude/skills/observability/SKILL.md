---
name: observability
description: The standard for adding observability to a Cogni node's code — what to log, the event registry, nodeId, metric labels, privacy, and the pre-ship self-check. Use whenever you add or review a route / feature / adapter and must instrument it (logs or metrics) before shipping, or when asked "how do I add proper observability / logging / metrics here", "is this instrumented right", or "review the observability on this PR". The contract lives in the operator knowledge hub, not in this file.
---

# observability

> The contract lives in the hub, not here. This file is only the trigger.

Fetch the node-developer observability contract — the instrument-before-you-ship finish pass (budget, event registry, `nodeId`, metric labels, privacy, and the 6-question ship gate):

```bash
# $KEY = a Cogni API key (from .env.cogni: COGNI_NODE_API_KEY)
curl -fsS -H "Authorization: Bearer $KEY" \
  https://cognidao.org/api/v1/knowledge/node-observability-finish-pass | jq -r .content
```

The short version:

- **Minimal, high-signal only.** Max 3 logs/request (4 if streaming). No redesign.
- **Event names from the registry** (`src/shared/observability/events/index.ts`, `EVENT_NAMES`) via the typed `logEvent()` helper — never an inline string.
- **`nodeId` is verified, not added** — it is bound at bootstrap from `.cogni/repo-spec.yaml`. If a line or metric lacks it, that's a bug; file it.
- **Exactly one deterministic terminal event** per operation (success OR error) with a stable `errorCode` enum on failure. A "sent" line with no outcome is worse than no log.
- **Metrics only if you'll alert/graph it**; low-cardinality labels only.
- **Privacy:** never log secrets, headers, URLs, bodies, or prompts — only enums, counts, durations, coarse status.

Read back what you logged through the operator proxy — hub entry `node-service-logs-read` (or `.claude/commands/logs.md`).

## This repo runs more than a node app

The hub contract is scoped so a single forked node can follow it verbatim. The operator monorepo additionally runs **`services/scheduler-worker`** (its own `WORKER_EVENT_NAMES` registry, `logWorkerEvent()`, and `/metrics` endpoint) and **Python infra** (LiteLLM callbacks — structured JSON with `nodeId`, never plain-text `logging`). The fuller cross-service checklist, including inter-node callback logging (`internode.*` with both `sourceNodeId` and `targetNodeId`), lives in `.claude/commands/observability.md`. Use the hub contract for the node app; reach for the command when you touch the worker or Python services.
