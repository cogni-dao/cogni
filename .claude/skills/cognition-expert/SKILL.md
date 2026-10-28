---
name: cognition-expert
description: "Session-bootstrap + cognition-delivery expert for Cogni nodes — how an agent actually receives (or fails to receive) its operating contract at session start, across Claude Code, Codex, and opencode. Points at the canon (docs/spec/node-baas-architecture.md §Cognition Substrate, scripts/agent/session-cognition.sh, nodes/operator/app/src/app/api/v1/cognition/{route,_bundle}.ts) and holds the durable mental model + hard-won gotchas that aren't obvious when you read it: the two-axis design (hub-owned complete contract vs code-owned delivery and recovery), why the SessionStart hook is NOT a universal injection surface, and why each harness needs a native full-context path. Use when touching the cognition bundle, the session-start loader, AGENTS.md/CLAUDE.md bootstrap, the .cogni/.cognition-cache.md cache, @imports, .codex/config.toml, opencode.json instructions, SESSION_BOOTSTRAP_INVARIANTS, the served orientation entry, or when debugging why a fresh agent booted without its agent-contract / replied in prose instead of the status-contract / got a truncated bundle. Triggers: 'cognition bundle', 'session-cognition.sh', 'SessionStart hook', 'agent-contract not loading', 'status-contract', 'bundle truncated', 'Output too large / Preview first 2KB', 'additionalContext', 'additionalContextLimit', 'CLAUDE.md @import', 'CLAUDE.local.md', '.cognition-cache.md', 'AGENTS.md bootstrap', 'thin pointer', 'ONE_VOICE', 'orientation IS the constitution', 'SESSION_BOOTSTRAP_INVARIANTS', 'opencode AGENTS.md', 'Codex project_doc_max_bytes', 'why did a fresh agent not follow the contract', 'cross-harness bootstrap', 'hub-empty boot', 'cognition didn't load'."
---

# cognition-expert

> How an agent's operating contract reaches its context at session start — the most load-bearing, most-silently-broken part of the node substrate. A fresh agent that never receives its contract is an invalid agent that looks fine.

This file is a **discovery adapter**, not a second maintained map. The complete, authoritative cognition-expert content — the two-axis mental model, the per-harness delivery table, and the hard-won gotchas — lives on the hub and reaches every session through the cognition cache. Do not re-add that content here; refine it in place on the hub.

Read, in order:

- **[cognition-expert](https://cognidao.org/knowledge/cognition-expert)** — implementation navigation, trigger, and gotchas (the hub skill).
- **[cognition-substrate-bootstrap](https://cognidao.org/knowledge/cognition-substrate-bootstrap)** — the owning two-axis design: ownership, delivery, distribution, acceptance.
- **[cognition-substrate-visual](https://cognidao.org/knowledge/cognition-substrate-visual)** — the human-readable visual of the same design.

The current tree is the source of truth for the code paths (`scripts/agent/session-cognition.sh`, `nodes/operator/app/src/app/api/v1/cognition/{route,_bundle}.ts`, `CLAUDE.md`, `.codex/config.toml`, `opencode.json`, the output style, and the warn-only detector); inspect it before editing.
