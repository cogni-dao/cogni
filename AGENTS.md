# AGENTS.md — Cogni

> Empower decentralized communities to build, ship, and govern trustworthy AI-native software, fast — and credit every contributor fairly. One click spawns a crypto-native community AI with its whole backend already running, so each node builds its mission, not its plumbing — and grows into the living expert on its niche.

## Your cognition is served at session start — this file only bootstraps it

Your real working context — the agent-contract (how you work _and_ communicate), orientation, the live skills index, knowledge domains, and the work-item API — is delivered as a **cognition bundle** from the node's hub, injected into your context at session start. **That bundle is the single source of truth.** This file exists only to load it; never act on a stale copy of an invariant that lives in the bundle.

- **Bundle:** `GET https://cognidao.org/api/v1/cognition` (authed, index-only — needs a principal)
- **Discovery:** `GET https://cognidao.org/.well-known/agent.json` → `cognition` + `endpoints`

SessionStart hooks inject it automatically — Claude Code ([`.claude/settings.json`](.claude/settings.json)) and Codex ([`.codex/config.toml`](.codex/config.toml)) both run the shared loader [`scripts/agent/session-cognition.sh`](scripts/agent/session-cognition.sh) and inject its stdout. The loader derives the node URL from `.cogni/repo-spec.yaml` `intent.name` and reads `.env.cogni` itself; no per-session URL or key export is required after bootstrap.

**If it didn't load** (no SessionStart hook, no key in `.env.cogni`, or the hub was unreachable), self-serve — register for a NODE agent key first (the one public seam), save it as `COGNI_NODE_API_KEY` in `.env.cogni`, then fetch with it:

```bash
KEY=$(curl -fsS -X POST https://cognidao.org/api/v1/agent/register \
  -H 'content-type: application/json' -d '{"name":"my-agent"}' | jq -r .apiKey)
printf 'COGNI_NODE_API_KEY=%s\n' "$KEY" >> .env.cogni
curl -fsS -H "Authorization: Bearer $KEY" https://cognidao.org/api/v1/cognition | jq -r .markdown
```

Operator keys such as `COGNI_API_KEY_PROD` are CI/CD authority and are **not** sufficient for session cognition; bootstrap must write `COGNI_NODE_API_KEY`. **Codex needs a one-time trust** of the `.codex/` layer (approve via `/hooks`). Why this shape: [`docs/spec/node-baas-architecture.md`](docs/spec/node-baas-architecture.md) § Cognition Substrate.

## First time here?

Run the [`/contribute-to-cogni`](.claude/skills/contribute-to-cogni/SKILL.md) skill — the E2E contributor contract (registration → worktree → CI → candidate-a validation → operator-merged PR). The irreducible loop, Definition of Done, and how to communicate all come from the bundle each session — read them there, not from a doc that can drift.

> Subdir `AGENTS.md` files extend this; closest file wins ([agents.md spec](https://agents.md/)). Each `nodes/<node>/AGENTS.md` defines that node's rules — read it once you know your scope.
