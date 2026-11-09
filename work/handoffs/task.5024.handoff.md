---
id: task-5024-handoff
type: handoff
title: "task.5024 handoff — operator identity broker"
status: active
trust: draft
summary: "Start-here for anyone picking up the operator identity broker. What the bug was, what shipped, the one remaining human gate, and the four follow-ups with their boundaries."
read_when: Taking over task.5024, or touching /identity/attest, the attestation contract, or OAuth client registration.
owner: derekg1729
created: 2026-08-27
verified: 2026-08-27
tags: [identity, oauth, handoff, task-5024]
---

# task.5024 handoff — operator identity broker

> **Read this first, then `docs/design/identity-broker-verdict.md` for the why.**
> The work-item summary on `task.5024` is a long append-only log — this file is the readable state.

## The bug, in one paragraph

A node asks the operator to prove a contributor's GitHub identity. The operator was
supposed to authenticate GitHub; **it never called GitHub at all.** It read
`getServerSessionUser()` and returned whatever GitHub account that operator session
already had linked. On the 2026-08-19 candidate a human intended `flock-leader` and the
system attested `derekg1729` — then the node correctly, atomically, cryptographically
imported the wrong binding. Every wire control worked and every one of them protected the
wrong subject.

`prompt=select_account` could not have helped: no authorization request was ever made.

## What shipped

The broker now performs a real GitHub authorization per request, and **the operator
account is gone from the flow** — no session read, no user minted, no binding consulted.
The fix is an _absence_, not a check, so it cannot be quietly removed.

| leg      | route                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| entry    | `/identity/attest` — validates the node request, then redirects to GitHub with `prompt=select_account`, empty scope, S256 PKCE           |
| callback | `/api/auth/attest/callback/[provider]` — matches `state`, exchanges the code, discards the token                                         |
| confirm  | `/identity/attest/confirm` → `/api/auth/attest/confirm` — names the resolved `@login` and the asking node; nothing is signed before this |

Request/claims of `identity.attestation.v1` are unchanged, so the frozen fingerprint still
matches node-template.

## The one remaining gate — human-only, on purpose

This feature's human axis **is** choosing a GitHub account. Substituting captured auth
would recreate the confused deputy the PR fixes, so it is not automatable.

1. `https://node-template-test.cognidao.org/profile`, signed in with the disposable wallet
2. **Verify GitHub** → pick `flock-leader` (`295942454`) in GitHub's picker
3. Confirm on the operator screen naming `@flock-leader`
4. **PASS = the node reads back “Verified GitHub @flock-leader on this node.”**
   Any other login — especially `derekg1729` — is the original bug back.

Merge of both PRs is prohibited until that passes.

## Traps this cost us — do not rediscover

| trap                              | what happens                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OAuth callback registration**   | A provider matches the registered URL plus sub-paths **only while an app holds exactly one redirect URI** (GitHub's legacy implicit wildcard). Adding a second URI switches the app to exact matching and silently breaks the first, while the registration still looks correct. Register **exact full URLs** per route. See hub entry `oauth-per-env-proxy` (https://cognidao.org/knowledge/oauth-per-env-proxy). |
| **You cannot probe this**         | Providers validate `redirect_uri` only _after_ sign-in. An anonymous `curl` returns the login page either way — a false pass. Browser only.                                                                                                                                                                                                                                                                        |
| **NextAuth lies about readiness** | It advertises a provider whenever credentials exist, regardless of whether the callback is registered. A provider on the sign-in page proves nothing.                                                                                                                                                                                                                                                              |
| **Redirects from `request.url`**  | Inside the container that is the pod origin, so redirects went to `https://0.0.0.0:3000/...`. Build them from `APP_BASE_URL` via `brokerUrl()`.                                                                                                                                                                                                                                                                    |
| **Flighting too early**           | `POST /api/v1/vcs/flight` fails with `remote-source artifact image not found` if the child image has not published yet. Wait for the image, not just CI. Transient `503 authz_unavailable` clears on retry.                                                                                                                                                                                                        |

## Follow-ups, and their boundaries

| item         | scope                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task.5041`  | OAuth clients for preview + Google. Track A (preview) is registrations only; Track B (Google) needs a Cloud project + consent screen first.                                                                                                                                                                                                                                                           |
| `spike.5000` | Replace the bespoke wire with OIDC. **We are already ~80% there** — JWKS, client registry (the catalog), PKCE and a consent screen all exist; discovery + `/token` + standard claim names are missing. **Land it before `task.5026`:** the ~326-line verifier lives in `node-template`, so the debt exists once today and fleet rollout forks it to every node. This is the cheapest it will ever be. |
| `bug.5061`   | candidate-a and preview were found sharing one OAuth client.                                                                                                                                                                                                                                                                                                                                          |
| —            | **Do not do a bespoke v2 contract and the OIDC migration separately.** `identity.attestation.v1` hardcodes a literal `github: {id, login}` claim, so attesting Discord/Notion claimants needs a new subject shape — and in OIDC that dissolves into `sub` + custom claims. Bumping the contract twice is waste.                                                                                       |

## The correction that matters most for a new reader

An earlier version of this work claimed attestation was git-specific — "the broker proves a
git author, so it covers forges; sign-in-only providers never need it." **That taxonomy was
invented and the codebase contradicts it:** `claimantKey()` is
`identity:${provider}:${externalId}` and `user_bindings.provider` already admits
`wallet | discord | github | google`. A Discord contribution produces
`identity:discord:<snowflake>`, and claiming it requires proving control of that Discord
account — the broker's exact job. Contributions to a node are not only commits.

The single-provider allowlist is a **contract limit**, not a principle.

## Where the rest lives

- `docs/design/identity-broker-verdict.md` — threat model, options rejected, prior art
- `docs/spec/decentralized-user-identity.md` — as-built contract + invariants
- Hub: `identity-broker-subject-provenance`, `oauth-per-env-proxy` (executable GitHub + Google registration steps), `node-spawn-attribution-scorecard`
- `task.5024` work item — full append-only history, including every candidate probe
