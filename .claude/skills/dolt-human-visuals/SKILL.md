---
name: dolt-human-visuals
description: Use before authoring or reviewing a Cogni knowledge entry with entryType html — a diagram, matrix or status grid for human review. Html is diagram-first, themed by the renderer, and nearly prose-free; anything an agent must recall stays a markdown text atom.
metadata:
  role: specialist
  scope: implementation
---

# dolt-human-visuals

> The contract lives in the node-template hub, not here. This file is only the trigger.

Read these node-template-owned entries with `COGNI_NODE_TEMPLATE_API_KEY` (on node-template itself, `COGNI_NODE_API_KEY`), then follow them:
- `GET https://node-template.cognidao.org/api/v1/knowledge/knowledge-human-visuals` — the diagram-first budget, fragment-only shape, theme tokens, `cogni-*` classes and review checklist
- Reference atom: `GET https://node-template.cognidao.org/api/v1/knowledge/cogni-harness-design`

No key yet? Register once with `POST https://node-template.cognidao.org/api/v1/agent/register` and `{"name":"<agent name>"}`, then save the key in the gitignored `.env.cogni`.

Write the html entry itself to this node's own hub. Do not reconstruct or preserve a fallback copy in this repository.
