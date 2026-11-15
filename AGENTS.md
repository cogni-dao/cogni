# AGENTS.md — Cogni bootstrap floor

The complete session agent-contract, including the exact response format and all
communication semantics, lives in this node's cognition bundle (`## The agent-contract`),
served from `/api/v1/cognition`. Follow that loaded contract for normal work. This file
owns bootstrap, local execution safety, and recovery only; it does not define a second
response format.

## Native delivery

Every session start fetches the bundle from the node hub through the shared loader
(`scripts/agent/session-cognition.sh`), which validates contract completeness before
admitting it. The gitignored `.cogni/.cognition-cache.md` is the last-known complete
bundle: an unavailable hub or incomplete response presents it instead.

The contract must already be model-visible before normal work: Claude receives it as
labelled SessionStart parts (`--claude-part`, each under its context-entry limit); Codex
receives uncapped SessionStart context; supported OpenCode 1.x refreshes the cache in a
plugin and loads it through `opencode.json.instructions`. Do not manually read the cache
merely to bootstrap; a missing native delivery is a delivery failure.

## Recovery when no complete contract is loaded

Stay in bounded bootstrap recovery; do not start normal task work or treat AGENTS.md,
skills, a map-only bundle, or a recovery notice as a replacement contract. Limit activity
to diagnosing delivery, recovering this node's credentials, and warming a complete bundle.
Run the shared loader from the repository root once and inspect the setup result. If it
still cannot load a complete contract, report the missing delivery evidence and the
specific setup action needed; do not repeatedly fetch or invent a fallback format.
Do not offer to waive the missing contract or ask the human to authorize normal work
without it. Recovery ends only when the native instruction path loads a complete bundle.

On first setup, register through `/api/v1/agent/register` and save COGNI_NODE_API_KEY in
the gitignored `.env.cogni`. Operator CI/CD credentials are not cognition credentials.

## Local execution safety

Heavy local commands default to NO. `pnpm check`, `pnpm check:fast` (and `:fix`),
`pnpm dev`, and the unfiltered `pnpm test` suite require the human's explicit request
and consent this session. Lightweight targeted checks run freely: Biome / `pnpm lint`
on touched paths, `pnpm typecheck`, and at most 1–2 specific test files. Proof is
defined by the bundle's tooling invariants, never by local tests.

Work against exactly one node and work item. The operator at https://cognidao.org
coordinates code, CI, flight, validation, and merge. Subdirectory AGENTS.md files extend
this floor; the closest file wins for code-local rules.

Pointers: [code delivery](.agents/skills/contribute-to-cogni/SKILL.md) ·
[Node BaaS product model](https://cognidao.org/knowledge/node-baas-substrate-model) ·
[discovery](https://cognidao.org/.well-known/agent.json)

Local development: follow the [local agent development guide](https://cognidao.org/knowledge/local-agent-development). Use the target node repository, its environment example, and its own startup commands. Current node discovery and schemas take precedence over old operator examples.
