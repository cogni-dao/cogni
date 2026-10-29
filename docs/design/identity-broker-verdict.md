---
id: identity-broker-verdict
type: design
title: "Identity broker: design verdict"
status: accepted
trust: reviewed
summary: "Why the operator brokers GitHub identity for nodes, why the confused-deputy fix is an absence rather than a check, which alternatives were rejected and on what evidence, and the OIDC gap that remains."
read_when: Changing the identity broker, the attestation contract, or deciding where fleet auth lives.
owner: derekg1729
created: 2026-08-27
verified: 2026-08-27
tags: [identity, oauth, design, task-5024]
---

# Identity broker: design verdict

> As-built behaviour lives in the hub rule [identity-attestation-v1](https://cognidao.org/knowledge/identity-attestation-v1).
> Registration steps live in [`oauth-app-setup.md`](../guides/oauth-app-setup.md).
> This file holds the **why**, including the paths not taken.

## The defect this exists to prevent

The broker read the attested GitHub identity from whatever operator session happened to be
present. A session answers _"someone is logged in"_ — it does not answer _"this human
intends to bind this account to this node, right now."_ An issuer that holds signing
authority and infers intent from ambient state is a **confused deputy**.

**The fix is an absence.** No broker leg reads a session, mints a user, or consults a
binding. There is no ambient account left to mis-read, so the failure is not merely
guarded against — it is unrepresentable. A source guard fails the build if any leg
reintroduces a session read.

`ATTESTATION_SUBJECT_FROM_AUTHZ` is the invariant: the subject comes only from an
authorization response correlated to that request.

## Why a broker at all

Nodes do not run their own GitHub OAuth, for one reason that survives scrutiny:
**credential blast radius.** Node-direct OAuth puts the client secret on every node, so one
node's compromise is fleet-wide.

Registration limits are a _secondary_ argument and are no longer absolute — GitHub raised
OAuth Apps to 10 redirect URIs with per-URI wildcard matching on 2026-08-14. An earlier
version of this design leaned on "an OAuth App has exactly one callback URL"; that was true
when written and is now false. The conclusion held because it never actually rested on it.

Ephemeral hosts settle it independently: `preview-deployments.md` mints a new
`{slug}.preview.cognidao.org` per preview, which cannot be pre-registered.

## Alternatives rejected

| option                                                                   | why not                                                                                                                                                          |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-node or fleet-shared OAuth on each node                              | client secret on every node; see above                                                                                                                           |
| A single callback shared with NextAuth sign-in, discriminated by `state` | requires intercepting NextAuth's `[...nextauth]` handler, and re-couples the broker to the account model — the exact defect being fixed                          |
| Adopt a mature OSS IdP (Keycloak / Zitadel / Hydra / Dex)                | does not fix subject provenance — an IdP with a live SSO session commits the identical error — and adds a stateful service per environment                       |
| DID / VC credential system                                               | superseded by the node-local-UUID + evidenced-bindings model already accepted in [user-identity-bindings](https://cognidao.org/knowledge/user-identity-bindings) |

## Prior art: this conclusion was reached twice

[PR #857](https://github.com/cogni-dao/cogni/pull/857) (2026-04, never merged, `nodes/auth`
never landed on `main`) proposed a dedicated auth node at `auth.cognidao.org` and reached
the same diagnosis independently: _"GitHub only trusts one callback/base domain, so the
clean fix is one shared auth hub and one GitHub OAuth callback."_

Where it is **superseded**: its `sub → local user_id` federation contradicts
`ATTESTATION_ACCOUNTS_INDEPENDENT`, the later reviewed decision that nodes keep sovereign
accounts. Where it is **not**: the hub-as-its-own-node, standard-OIDC shape was never
rejected — it simply stalled.

## The gap that remains: this wire should be OIDC

The current request/response shape is bespoke, and the honest assessment is that this is
**tech debt, not a considered boundary.** We are already most of the way to OIDC:

| present                                                                                                | missing              |
| ------------------------------------------------------------------------------------------------------ | -------------------- |
| JWKS endpoint                                                                                          | discovery document   |
| client registry — a catalog `node_id` _is_ a `client_id`, `deploy_envs` _are_ registered redirect URIs | `/token` endpoint    |
| S256 PKCE                                                                                              | standard claim names |
| consent screen                                                                                         |                      |

The bespoke parts rename things OIDC already defines: protocol fingerprint → `client_id`;
`targetOrigin` → `redirect_uri`; our nonce → `nonce`; attestation JWT → `id_token`; the
`#attestation` fragment → `code` + `/token`, which also removes the front-channel assertion.

Cost of staying bespoke: roughly 326 lines of hand-rolled protocol duplicated into every
node repo, where an off-the-shelf client would do.

Tracked as `spike.5000`, with two sequencing constraints:

1. **It must not be done separately from the provider-generic subject work.**
   `identity.attestation.v1` carries a literal `github: {id, login}` claim, and in OIDC that
   dissolves into `sub` plus custom claims. Bumping the contract twice is waste.
2. **It should land before `task.5026` (fleet rollout).** The verifier lives in
   `node-template`, so today the debt exists once. Fleet rollout forks it to every node and
   the migration becomes an N-repo fork-sync instead of a one-repo change. This is the
   cheapest it will ever be.

Deliberately **not** folded into `task.5024`: that task is the confused-deputy security
fix, which is proven on candidate. Rewriting the wire in the same change would put an
unvalidated rewrite in front of the only gate that catches this class of bug — a human
driving the real flow.

## Attestation is not git-specific

An earlier framing justified a single attestable provider as "the broker proves a git
author, so it covers forges only." That taxonomy was invented and the codebase contradicts
it: `claimantKey()` is `identity:${provider}:${externalId}`, and `user_bindings.provider`
already admits `wallet | discord | github | google`. A Discord contribution produces the
claimant `identity:discord:<snowflake>`, and whoever claims it must prove control of that
Discord account on that node.

The single-entry allowlist is a **contract limit**, not a principle. Widening it without a
v2 subject shape would sign a claim the wire cannot represent.

## Accepted risks

- **Single fleet signing key.** Operator key compromise forges any binding on any node.
  TTL-only revocation; JWKS rotation is unbuilt.
- **Assertion in the URL fragment.** Mitigated in practice — it is audience-, node- and
  nonce-bound, so it is inert without the relying node's unconsumed one-time nonce, and the
  node strips it from history on arrival. `spike.5000` removes it properly.
- **Both OAuth apps are personal, under one account**, not org-owned — a bus-factor and
  access-review gap.
