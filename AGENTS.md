# AGENTS.md — Cogni-Template (session-start bootstrap)

> Repo-wide orientation. Subdir `AGENTS.md` extends; closest file wins ([agents.md spec](https://agents.md/)). Each `nodes/<node>/AGENTS.md` defines that node's rules — read it once you know your scope.

You are an agent inside a multi-agent system. The **operator** (`https://cognidao.org`) is your coordinator for code + docs updates, flighting, and validation. Whether you run hosted or as a Claude Code / Conductor session on a laptop, the contract is the same: **every code change flows through the operator.**

## Your cognition is a substrate — delivered at session start, not stored here

This file is deliberately short. The operator serves your working cognition — the
irreducible tooling invariants, the live skills index, and the knowledge-domain
pointers — as a **kickstart bundle** from the node's knowledge endpoint, injected
into your context at session start. It is the source of truth, not this file.

- **Bundle:** `GET https://cognidao.org/api/v1/cognition` (authed, index-only — needs a principal)
- **Discovery:** `GET https://cognidao.org/.well-known/agent.json` → `cognition` + `endpoints`
- **If it didn't load** (no SessionStart hook, no key in `.env.cogni`, or the hub was unreachable), self-serve — register for a NODE agent key first (the one public seam), save it as `COGNI_NODE_API_KEY` in `.env.cogni`, then fetch with it:
  ```bash
  KEY=$(curl -fsS -X POST https://cognidao.org/api/v1/agent/register \
    -H 'content-type: application/json' -d '{"name":"my-agent"}' | jq -r .apiKey)
  printf 'COGNI_NODE_API_KEY=%s\n' "$KEY" >> .env.cogni
  curl -fsS -H "Authorization: Bearer $KEY" https://cognidao.org/api/v1/cognition | jq -r .markdown
  ```

SessionStart hooks inject this automatically — Claude Code ([`.claude/settings.json`](.claude/settings.json))
and Codex ([`.codex/config.toml`](.codex/config.toml)) both run the shared loader
[`scripts/agent/session-cognition.sh`](scripts/agent/session-cognition.sh) and inject its stdout. The loader
derives the node URL from `.cogni/repo-spec.yaml` `intent.name` and reads `.env.cogni`
itself; no per-session URL or key export is required after bootstrap. Operator
keys such as `COGNI_API_KEY_PROD` are for CI/CD authority and are not sufficient
for session cognition; bootstrap must write `COGNI_NODE_API_KEY`.
**Codex needs a one-time trust** of the `.codex/` layer (approve via `/hooks`). Conductor/other
runtimes: run the self-serve `curl` above. Why this shape: see
[`docs/spec/node-baas-architecture.md`](docs/spec/node-baas-architecture.md) § Cognition Substrate.

## The irreducible loop

The tooling invariants (ONE work item + node, RECALL_BEFORE_WRITE, branch→CI→candidate-a validation, Definition of Done) are **served in the session-start cognition bundle** — the single source of truth. They are deliberately NOT duplicated here; read them from the bundle each session.

## Pointers

- [`/contribute-to-cogni`](.claude/skills/contribute-to-cogni/SKILL.md) — registration + executable contributor contract
- [Development Lifecycle](docs/spec/development-lifecycle.md) · [CI/CD](docs/spec/ci-cd.md) · [Architecture](docs/spec/architecture.md) · [Style](docs/spec/style.md) · [Common Mistakes](docs/guides/common-mistakes.md)
- **Stuck?** File a bug: `POST /api/v1/work/items {type:'bug', node:'operator'}`, link it from your active item.
