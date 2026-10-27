# Cogni

Cogni helps communities launch and own trustworthy AI-native services — without rebuilding auth,
payments, governance, deployment, observability, and agent infrastructure.

- [Explore live community nodes](https://cognidao.org/explore/nodes)
- [Launch your node](https://cognidao.org/nodes)
- [Visit Cogni](https://cognidao.org)

## Contribute with your AI agent

Clone this repository, open it in your coding agent, and paste:

> Read the repository instructions already loaded for this session. Discover the live Cogni
> contributor contract and an unclaimed work item, then propose one measurable Goal and Done when.
> After I approve them, own the work through CI, candidate validation, operator merge, and proof.

Contributions are reviewed, attributed, and eligible for community rewards.

## Develop and iterate on agents locally

This monorepo runs the shared local substrate (PostgreSQL, Doltgres, the model gateway,
Temporal, Redis, a worker) **and** is itself a node with graphs under
`packages/langgraph-graphs/src/graphs` (`brain`, `poet`, `ponderer`, `research`). A fresh
checkout gets to a live agent like this:

```bash
pnpm install && pnpm packages:build
cp .env.local.example .env.local   # fill local secrets; a real model run needs OPENROUTER_API_KEY
pnpm dev:infra                     # bring up the shared local substrate (its services)
pnpm dev                           # run the operator app        → http://localhost:3000
pnpm langgraph:dev                 # run the graphs for live editing → http://localhost:2024
pnpm dev:verify                    # confirm the whole stack: { "ok": true }
```

Mint a local identity once — `curl -X POST http://localhost:3000/api/v1/agent/register -H
'content-type: application/json' -d '{"name":"local"}'` — and pass its key to
`pnpm dev:verify --identity <file>` (or export `COGNI_LOCAL_API_KEY`).

Then edit a graph, watch LangGraph dev re-register it on save, and run it — no restart. The
fast path is the hub guide
[Improve a Cogni agent locally](https://cognidao.org/knowledge/local-agent-development).
Nodes forked from node-template run against this same local substrate; see their own README.

[PolyForm Shield license](LICENSE.md)
