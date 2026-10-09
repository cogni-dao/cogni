---
id: agent-identity-setup-guide
type: guide
title: Agent Identity Setup
status: draft
trust: draft
summary: How to give an AI/coding-agent its own git + GitHub identity with independently-scoped, revocable permissions — separate from your personal account — so you can let it work autonomously with a bounded blast radius and honest attribution.
read_when: Setting up an AI/coding agent to commit, push, or authenticate on your behalf (Claude Code, Conductor, a fork-provisioning agent), or diagnosing why agent commits show up under a human's GitHub account.
owner: derekg1729
created: 2026-10-09
verified: 2026-10-09
tags: [onboarding, agent, identity, security]
---

# Agent Identity Setup

## When to Use This

You are about to let an AI/coding agent (Claude Code, a Conductor session, a
fork-provisioning agent, CI automation) commit, push, or authenticate against
GitHub or any external system. Set this up **before** the agent does any work.

The rule this guide implements: **an agent acts under its own identity — a
distinct account, email, and credential set with independently-scoped,
revocable permissions — never under your personal credentials.** (Hub:
`method/agent-identity-not-human`.)

## Why bother — three payoffs

- **Scoped autonomy.** A separate principal takes least-privilege, revocable
  grants. You can confidently let the agent "run wild" _because_ wild is fenced
  to what that identity was granted — and you revoke it without touching your
  own access.
- **Contained blast radius.** A leaked key, a bad push, or a runaway loop is
  capped at the agent account. Sharing your personal credentials makes _you_
  the blast radius.
- **Honest attribution.** Git attributes a commit by its author **email**, and
  GitHub maps that email to whichever account has it verified. Agent work under
  your email is counted as _your_ human activity, forever.

## The attribution trap (read this first)

GitHub does **not** attribute by the commit's display `name`. It attributes by
the author **email**. So this looks right and is wrong:

```
user.name  = flock-leader                 # looks like the bot
user.email = you@personal.com             # verified on YOUR human account
```

Every commit authored with that config lands on your **personal** GitHub
account, no matter what the name says. The failure is silent and compounds —
it can mis-attribute hundreds of commits before anyone notices, and rewriting
that history after the fact means force-pushing across many merged PRs (usually
not worth it).

A repo-local override is the usual culprit: a correct **global** `user.email`
is silently defeated by a stale `user.email` in one clone's `.git/config`.
Always verify the _resolved_ identity, not just what `git config user.name`
prints:

```bash
git var GIT_AUTHOR_IDENT
# want: flock-leader <you+agent@…>  — NOT your personal email
git config --show-origin --get-all user.email   # catch a local override
```

## Setup

### 1. Create the agent's GitHub account

Create a dedicated GitHub account for the agent (e.g. a `-bot` / `-agent`
handle). This is the account referenced as the "bot user" throughout the
bootstrap docs (see [Agentic Fork Bootstrap](../spec/agentic-fork-bootstrap.md)
§GitHub Admin Role).

### 2. Give it its own verified email — not yours

Use a distinct address the agent account owns and has **verified**. A Gmail
`+` alias works and routes to your inbox while staying a separate address:

```
you+agent@gmail.com     # verified on the AGENT account, never on your personal one
```

> The `+alias` must be verified on the **agent** account. If the same address
> is verified on your personal account, GitHub attributes to you again.

### 3. Configure git to author as the agent

Set it globally for the machine/VM the agent runs on:

```bash
git config --global user.name  "your-agent-handle"
git config --global user.email "you+agent@gmail.com"
```

Then confirm no clone overrides it (the trap above):

```bash
git var GIT_AUTHOR_IDENT
git config --show-origin --get-all user.email   # expect ONLY the global line
# if a repo-local override exists:  git config --unset user.email
```

For **Claude Code remote / web sessions**, set authorship via the environment
instead — the SessionStart hook reads it and configures git automatically (and
fails closed to avoid "Claude"-attributed commits). See
[Developer Setup → Claude Code Remote Sessions](./developer-setup.md#claude-code-remote-sessions):

```
GIT_AUTHOR_NAME=your-agent-handle
GIT_AUTHOR_EMAIL=you+agent@gmail.com
```

### 4. Grant scoped, revocable permissions — not your roles

Grant the agent account only what it needs, explicitly, so you can revoke it
without touching your own access:

- Add it as a repo **collaborator** at the minimum role the task needs (the
  bootstrap flow needs Admin to mint env secrets — scope grants to the real
  need; see §GitHub Admin Role).
- Mint a **fine-grained PAT** on the agent account, single-repo, least
  permissions (e.g. `Contents: Write`, `Pull requests: Write`, plus whatever
  the task genuinely requires). Prefer this over a classic PAT.
- Fine-grained PATs have a **90-day max lifetime** — plan for rotation.
- Never hand the agent your personal token or reuse your browser session.

### 5. Give it its own API / service identity too

The same principle extends past git: the agent gets its own API keys and its
own RBAC principal (e.g. a node-agent key), never your personal/operator
credentials. On Cogni nodes this is the `COGNI_NODE_API_KEY` the session
bootstrap writes — a per-agent principal, distinct from human operator keys.

## Verify before trusting autonomy

Run these before letting the agent loose:

```bash
# 1. Resolved git author is the agent, by EMAIL
git var GIT_AUTHOR_IDENT

# 2. No clone-local override shadowing the global
git config --show-origin --get-all user.email

# 3. The token belongs to the agent account, with the scopes you expect
gh api user --jq .login            # expect the agent handle, not yours
```

If all three show the agent — not you — the separation holds at the credential
layer, where the agent actually acts.

## How this fits the substrate

This is the human-facing posture that complements Cogni's identity model:
`actor_id` already carries `kind = agent` as a first-class subject distinct from
`kind = user` (see `docs/spec/identity-model.md` and hub
`build-core/identity-keys-no-overload`). This guide is how you keep that
separation true at the credential layer. The confused-deputy failure that
happens when an agent reads _ambient_ human identity instead of its own is
documented in hub `build-core/identity-broker-subject-provenance`.

## Related

- [Developer Setup](./developer-setup.md) — first-time repo setup; the Claude Code remote-session authorship note
- [Agentic Fork Bootstrap](../spec/agentic-fork-bootstrap.md) — the bot-PAT credential floor and §GitHub Admin Role
- [Fork Quickstart](../runbooks/fork-quickstart.md) — zero-to-green with a bot PAT as the only authority
- Hub rule: `method/agent-identity-not-human` — the one-line principle this guide operationalizes
