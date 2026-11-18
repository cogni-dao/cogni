---
name: kpi-portfolio-review
description: Review the whole measurement and autonomy portfolio critically. Use for enumerating a node's goals and KPIs per domain, the weekly metrics review, grading the AI operations matrix, or re-forming the metric set after a flow change such as a new work-item gate.
---

# kpi-portfolio-review

This file is only the trigger. The node-template hub hosts the authoritative, refinable method.

Read these node-template-owned entries with `COGNI_NODE_TEMPLATE_API_KEY` (on node-template itself, `COGNI_NODE_API_KEY`), then follow them:

- `GET https://node-template.cognidao.org/api/v1/knowledge/kpi-portfolio-review`
- `GET https://node-template.cognidao.org/api/v1/knowledge/metrics-expert`

Run the method against this node's own hub, `https://cognidao.org`, with its `COGNI_NODE_API_KEY`. Every read the method names is relative to that base, never to node-template. The operations matrix is `node-ai-operations-matrix` on this node's hub when it exists. The mission is this node's `intent.mission` from `.cogni/repo-spec.yaml`, as served by `GET https://cognidao.org/api/v1/cognition`.

No key yet? Register once with `POST https://node-template.cognidao.org/api/v1/agent/register` and `{"name":"<agent name>"}`, then save the key in the gitignored `.env.cogni`.

Do not reconstruct or preserve a fallback copy in this repository.
