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
checkout gets to a live, verified agent like this:

```bash
pnpm install && pnpm packages:build
cp .env.local.example .env.local   # fill local secrets; a real model run needs OPENROUTER_API_KEY
pnpm dev:infra                     # bring up the shared local substrate (its services)
pnpm db:setup                      # migrate + seed this node's databases

# Run the app and the graph server in two terminals (both stay running):
pnpm dev                           # operator app            → http://localhost:3000
pnpm langgraph:dev                 # graphs for live editing → http://localhost:2024

# Mint a local identity, then verify the whole stack:
mkdir -p .context
curl -sX POST http://localhost:3000/api/v1/agent/register \
  -H 'content-type: application/json' -d '{"name":"local"}' > .context/local-dev-identity.json
pnpm dev:verify --identity .context/local-dev-identity.json   # → { "ok": true }
```

`dev:verify`'s authenticated checks need the minted identity (above); without `--identity`
or `COGNI_LOCAL_API_KEY` they fail by design.

Then edit a graph, watch LangGraph dev re-register it on save, and run it — no restart. The
fast path is the hub guide
[Improve a Cogni agent locally](https://cognidao.org/knowledge/local-agent-development).
Nodes forked from node-template run against this same local substrate; see their own README.

[PolyForm Shield license](LICENSE.md)
