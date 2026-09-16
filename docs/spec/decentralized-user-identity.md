---
id: decentralized-user-identity
type: spec
title: User Identity + Account Bindings
status: active
spec_state: active
trust: reviewed
summary: Stable user_id (UUID) as canonical identity. Wallet, Discord, and GitHub are evidenced bindings — never the identity itself. "Contributor" is a derived label, not an identity primitive. DID/VC portability deferred to P2.
read_when: Working on identity, auth, account linking, RBAC actor types, user context injection, or ledger attribution
implements: proj.decentralized-identity
owner: derekg1729
created: 2026-02-19
verified: 2026-08-17
tags: [identity, auth, web3]
---

# User Identity + Account Bindings

> Every user gets a stable `user_id` (UUID) at first contact — regardless of auth method. Wallet, Discord, and GitHub identities are evidenced bindings attached to that user, never used as the identity itself. "Contributor" is a derived label (has eligible contribution events), not a separate identity primitive.

### Key References

|              |                                                                                           |                                            |
| ------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Project**  | [proj.decentralized-identity](../../work/projects/proj.decentralized-identity.md)         | Roadmap, phases, work items                |
| **Research** | [DID-first identity refactor](../research/did-first-identity-refactor.md)                 | Gap analysis, library eval                 |
| **Spec**     | [Identity Model](./identity-model.md)                                                     | Local user, actor, and binding boundaries  |
| **Spec**     | [Authentication](./authentication.md)                                                     | SIWE flow, wallet-session                  |
| **Spec**     | [RBAC](./rbac.md)                                                                         | Actor types (will drop wallet from format) |
| **Spec**     | [User Context](./user-context.md)                                                         | Agent identity injection                   |
| **Consumer** | [Attribution Pipeline](./attribution-pipeline-overview.md)                                | Identity claimant → local claim resolution |
| **Consumer** | [proj.transparent-credit-payouts](../../work/projects/proj.transparent-credit-payouts.md) | Claimant and future actor migration        |

## Design

### Identity Model

```
┌──────────────────────────────────────────────────────┐
│                     users table                       │
│  id: UUID (PK, FK target, canonical identity)        │
│  wallet_address: 0x... (legacy, kept for SIWE)       │
│  name: TEXT (optional display name)                   │
└──────────────┬───────────────────────────────────────┘
               │ 1:N
               ▼
┌──────────────────────────────────────────────────────┐
│               user_bindings table                     │
│  id: UUID (PK)                                        │
│  user_id: UUID (FK → users.id)                        │
│  provider: 'wallet' | 'discord' | 'github' | 'google' │
│  external_id: TEXT (UNIQUE per provider)               │
│  created_at: TIMESTAMPTZ                              │
└──────────────────────────────────────────────────────┘
               │ append-only
               ▼
┌──────────────────────────────────────────────────────┐
│              identity_events table                     │
│  id: UUID (PK)                                        │
│  user_id: UUID (FK)                                   │
│  event_type: 'bind' | 'revoke' | 'merge'             │
│  payload: JSONB (provider, external_id, evidence)     │
│  created_at: TIMESTAMPTZ                              │
└──────────────────────────────────────────────────────┘

Examples:
  user_bindings: discord | 123456789012345678 → user <uuid>
  user_bindings: wallet  | 0xabc...           → user <uuid>
  user_bindings: github  | 12345              → user <uuid>
```

**Two identity tiers (P0):**

| Tier           | Purpose                     | Type                   | Stability                                           |
| -------------- | --------------------------- | ---------------------- | --------------------------------------------------- |
| **User ID**    | Canonical member identifier | UUID v4 (`users.id`)   | Permanent — minted once at first contact            |
| **Binding(s)** | Auth methods bound to user  | provider + external_id | Current-state index; proof lives in identity_events |

**Why UUID instead of DID at P0?** DID requires crypto dependencies (ed25519, multicodec, base58btc) with zero user-facing value until federation. Ledger correctness needs stable, unique IDs — UUID does this. DID is a portability concern for P2, not an identity correctness concern for P0.

**Why `user_id` not `contributor_id`?** "User" is the stable concept — accounts, billing, sessions, permissions all reference users. "Contributor" is contextual and mutable (a user exists before contributing). Naming the canonical ID `contributor_id` would leak domain assumptions into every table and API.

### Auth Flows

**SIWE wallet login:**

```
Wallet Sign (RainbowKit) → SIWE Verify (src/auth.ts)
  → User Lookup by wallet_address
  → IF new user: createUser() → createBinding('wallet', address, { method: 'siwe' })
  → IF existing: createBinding() idempotent (onConflictDoNothing)
  → JWT { id, walletAddress }
```

**OAuth login (GitHub, Discord, Google):**

```
NextAuth OAuth → signIn callback → user_bindings lookup(provider, providerAccountId)
  → IF binding exists: return existing user.id
  → IF no binding: atomic tx (user + binding + event) → return new user.id
  → JWT { id, walletAddress: null }
```

**Account linking (authenticated user adds provider, DB-backed fail-closed):**

```
POST /api/auth/link/{provider}
  → INSERT linkTransactions row (txId, userId, provider, expiresAt)
  → Set signed JWT cookie { txId, userId, purpose: "link_intent" } (Path=/api/auth/callback, 5min TTL)
  → Return { ok: true }; client calls signIn(provider) to start OAuth
  → [...nextauth] route decodes JWT → pending or failed intent via AsyncLocalStorage
  → signIn callback: atomic consume (UPDATE WHERE consumedAt IS NULL AND expiresAt > now())
  → IF row returned → createBinding(provider, externalId) for existing user
  → IF no row → reject → /profile?error=link_failed (LINK_IS_FAIL_CLOSED)
  → IF UNIQUE violation for different user → reject (NO_AUTO_MERGE)
```

### Operator-Brokered GitHub OAuth (`identity.attestation.v1`)

**The operator IS the environment's auth node.** It holds the fleet's single GitHub
OAuth client; relying nodes configure none. A node asks the operator to authenticate a
GitHub account and return a short-lived, node-scoped proof of that OAuth result.

This is chosen for credential blast radius, not for callback cardinality. Node-direct
OAuth would place the client secret on every node, so one node's compromise would be
fleet-wide; and wildcard subdomain matching means any subdomain takeover receives fleet
authorization codes. Registration limits are a secondary constraint and are no longer
absolute — GitHub raised OAuth Apps to 10 redirect URIs with per-URI wildcard matching on
2026-08-14, and GitHub Apps have long allowed 10 — but 10 is still a ceiling, and
`preview-deployments.md` mints a new `{slug}.preview.cognidao.org` host per preview.

Environments do NOT share a client: production uses its own OAuth app, and all
non-production hosts share a second one. Each auth route registers its **exact** callback
URL on that app. Registering the `/api/auth/` prefix and expecting sub-paths to match
works only while an app holds exactly one redirect URI — GitHub enables wildcard matching
implicitly in that case, and adding a second URI switches to exact matching, silently
breaking the first.

A dedicated `auth.cognidao.org` node speaking standard OIDC remains a valid future home
(prototyped in PR #857, never merged). Moving there requires a stated reason; until then
the seam is kept as an OAuth 2.0 authorization-code subset so the move is a swap, not a
rewrite.

Operator and node accounts remain independent. The operator does not export its
`user_id`, wallet, or wallet-to-GitHub binding, and the node does not import an
operator account. The only portable fact is the GitHub provider id authenticated
in the broker round trip. The relying node binds that id to the local user who
owned the one-time nonce.

This follows `BINDING_IS_THE_MULTI_ENV_KEY` from the identity-model spec: a
`user_id` is a node/environment-local surrogate, while the stable external
GitHub id is the only cross-boundary identifier. The broker proof is deliberately
VC-shaped evidence, not a portable person identity or a cross-node account.

```text
node profile (locally authenticated user)
  → mint durable nonce owned by this node's local user_id
  → redirect to configured operator with
      {protocol fingerprint, nodeId, nonce, exact HTTPS target origin}
operator broker  (NO operator session is read at any point)
  → require the exact frozen v1 fingerprint
  → require target origin in that node's registered deploy environments
      (both BEFORE the human is sent to GitHub — never after an authentication
       the caller could not use)
  → carry {nodeId, nonce, targetOrigin, returnTo, state, PKCE verifier} in a
      signed HttpOnly cookie, and redirect to GitHub with
      prompt=select_account, allow_signup=false, empty scope, S256 PKCE
  → on callback: match state, exchange the code, read {id, login},
      DISCARD the access token; mint no operator user, binding, or event
  → require an explicit human confirmation naming the resolved @login and the
      asking node, with cancel and switch-account
  → only then sign a 10-minute EdDSA JWT containing GitHub id + exact request binding
  → return JWT in URL fragment to the exact registered /profile URL
node verifier
  → pin issuer + EdDSA JWKS + audience + nodeId + target origin + fingerprint
  → require the current local user to own the nonce
  → atomically consume nonce and create/refresh that user's GitHub binding + evidence
```

The protocol source is
`packages/node-contracts/src/identity.attestation.v1.contract.ts`. Operator and
node-template carry separate copies, so v1 is frozen by a canonical descriptor,
SHA-256 fingerprint, and identical conformance vectors. The fingerprint is
required in the request and signed claims: accidental one-sided drift fails
closed before issuance and again during JWT verification. Semantic changes
create a new protocol version; they do not mutate v1.

Only canonical HTTPS origins are accepted. HTTP, URL credentials, paths,
queries, and fragments are rejected rather than normalized. The
environment-local parent's merged catalog is the target-origin allowlist;
issuance App-reads `main` directly so a newly registered node does not wait for
the Postgres catalog projection. Request headers never select the issuer or
relying origin.

The implementation follows the inside-out dependency boundary:

| Layer            | Operator issuer                               | Node relying party                           |
| ---------------- | --------------------------------------------- | -------------------------------------------- |
| Contract         | strict request/claims + fingerprint           | identical frozen contract + start response   |
| Feature          | origin allowlist, claims, TTL                 | nonce TTL + redemption outcome state machine |
| Port             | node registry + signer (NO subject lookup)    | transactional nonce/binding repository       |
| Adapter          | App-read catalog + Jose signer (no user data) | Drizzle atomic consume/bind/evidence write   |
| Bootstrap/facade | dependency composition and HTTP mapping only  | dependency composition and HTTP mapping only |

`NO_AUTO_MERGE` remains authoritative: a GitHub provider id already owned by a
different local user returns `already_linked` and is never re-pointed. Nonce
consumption and the terminal binding decision share one database transaction;
infrastructure failures roll the nonce consumption back.

Git attribution first records the work under the stable external claimant key
`identity:github:<id>`. It does not require a Cogni account and is not rewritten
when someone later links that GitHub identity. At settlement/read time, a node
may resolve that identity claimant through its own `user_bindings` to the local
user who proved control of the GitHub account.

For P0, this lets a locally authenticated human prove control of an
agent-operated GitHub account such as `flock-leader` and claim its preserved
identity allocation. The broker does not encode future actor/beneficiary policy.

**Attestation is not git-specific.** `claimantKey()` is
`identity:<provider>:<external_id>` and `user_bindings.provider` already admits
`wallet | discord | github | google`, so a Discord contribution produces the claimant
`identity:discord:<snowflake>` — and whoever wants to claim it must prove control of
that Discord account on that node, which is exactly what the broker does. A node's
contributions are not only commits, and a node may involve no GitHub at all.

What limits v1 to GitHub is the wire contract, not the design: the claims carry a
literal `github: {id, login}` field. Generalising means a v2 whose subject is
`{provider, id, login}`; the routes, broker cookie, PKCE machinery, and provider
binding are already provider-generic. Widening the attestable-provider list without
that v2 would sign a claim the contract cannot represent.

### Session Type

```typescript
interface SessionUser {
  id: string; // users.id (UUID) — canonical identity
  walletAddress: string | null; // null for OAuth-only users
}
```

Business logic references `id` (= `user_id`). `walletAddress` is nullable — `null` for OAuth-only users. Wallet-gated operations (payments, ledger approval) guard on `walletAddress !== null`.

## Goal

Provide a stable, auth-method-agnostic identity inside each node. `users.id` works whether the user arrives via wallet, Discord, or any future auth method. Wallet and external accounts are evidenced bindings, not the identity itself. Attribution preserves external claimant provenance and resolves it through node-local bindings only when ownership or settlement needs a local account.

## Non-Goals

- Blockchain DID registry (Sidetree, ION, etc.) — P2+ at earliest
- DIDComm messaging — P2+
- Trust registry / multi-issuer federation — P2+
- On-chain reputation tokens
- Credential export / portability — P2+
- Changing the DB primary key approach (UUID stays)
- DID minting at P0 (deferred to P2 as optional alias)
- Separate `contributors` table — "contributor" is a derived label, not a table

## Invariants

| Rule                             | Constraint                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| USER_ID_AT_CREATION              | Every user gets a UUID minted at first contact. No user exists without one.                                                                                                                                                                                                                 |
| CANONICAL_IS_USER_ID             | Business logic identity references use `user_id`, never `wallet_address`, `discord_user_id`, or DID.                                                                                                                                                                                        |
| BINDINGS_ARE_EVIDENCED           | Every binding has proof recorded in `identity_events.payload` (SIWE signature, bot challenge, PR link). Bindings table is current-state index only.                                                                                                                                         |
| NO_AUTO_MERGE                    | If a binding's `(provider, external_id)` is already bound to a different user, the bind attempt fails. Never silently re-point. DB-enforced via UNIQUE.                                                                                                                                     |
| SIWE_UNCHANGED                   | SIWE authentication continues working. Binding additions are additive — no existing auth flow breaks.                                                                                                                                                                                       |
| ATTESTATION_V1_FROZEN            | Operator and node exchange and verify the same pinned protocol fingerprint; a one-sided drift fails closed.                                                                                                                                                                                 |
| ATTESTATION_TLS_ONLY             | Issuer and target are exact canonical HTTPS origins without URL credentials, path, query, or fragment.                                                                                                                                                                                      |
| ATTESTATION_ONE_TIME             | The relying node owns the nonce; consumption and binding decision commit atomically exactly once.                                                                                                                                                                                           |
| ATTESTATION_ACCOUNTS_INDEPENDENT | Operator user IDs, wallets, and binding relationships never cross the seam; only the node-scoped GitHub OAuth result is attested.                                                                                                                                                           |
| ATTESTATION_SUBJECT_FROM_AUTHZ   | The attested GitHub identity comes ONLY from the authorization response correlated to that request. No broker leg reads an operator session or a stored binding — an ambient session choosing the subject is a confused deputy, and it bound the wrong account on the 2026-08-19 candidate. |
| ATTESTATION_INTENT_IS_EXPLICIT   | `prompt=select_account` is necessary but NOT sufficient (picker only; no re-authentication; undocumented for 0/1 signed-in accounts). A confirmation naming the resolved login and the asking node is required before signing.                                                              |
| CLAIMANT_PROVENANCE_PRESERVED    | Linking `identity:github:<id>` to a local user changes claim resolution, never the finalized record of which external identity produced the work.                                                                                                                                           |
| UUID_STAYS_AS_PK                 | `users.id` (UUID) remains the relational PK and FK target.                                                                                                                                                                                                                                  |
| APPEND_ONLY_EVENTS               | `identity_events` rows are append-only. DB trigger rejects UPDATE/DELETE. Revocation creates a new event, never deletes rows.                                                                                                                                                               |
| LEDGER_PRESERVES_CLAIMANT        | Finalized attribution references stable user or external-identity claimant keys; wallets and DIDs are resolved bindings, never canonical statement keys.                                                                                                                                    |

### Schema

**Table:** `users` (existing — no rename needed)

| Column           | Type        | Constraints             | Description                           |
| ---------------- | ----------- | ----------------------- | ------------------------------------- |
| `id`             | TEXT        | PK                      | UUID v4, canonical identity           |
| `wallet_address` | TEXT        | UNIQUE                  | Ethereum address from SIWE (existing) |
| `name`           | TEXT        |                         | Optional display name (existing)      |
| `email`          | TEXT        |                         | Optional (existing)                   |
| `created_at`     | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | When user was created                 |

**Table:** `user_bindings` (new)

| Column           | Type        | Constraints                                                  | Description                                                                 |
| ---------------- | ----------- | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `id`             | TEXT        | PK                                                           | UUID v4                                                                     |
| `user_id`        | TEXT        | FK → users.id, NOT NULL                                      | User this binding belongs to                                                |
| `provider`       | TEXT        | NOT NULL, CHECK IN ('wallet', 'discord', 'github', 'google') | Binding type                                                                |
| `external_id`    | TEXT        | NOT NULL                                                     | Provider-specific ID (address, discord snowflake, github user id)           |
| `provider_login` | TEXT        |                                                              | OAuth username/login from provider profile (used for display name fallback) |
| `created_at`     | TIMESTAMPTZ | NOT NULL, DEFAULT NOW()                                      | When the binding was created                                                |

**Constraint:** `UNIQUE(provider, external_id)` — same external ID across different providers is allowed (GitHub numeric ID can equal a Discord snowflake). Proof/evidence lives in `identity_events.payload`, not on the binding row.

**Table:** `identity_events` (new, append-only)

| Column       | Type        | Constraints                                    | Description                                     |
| ------------ | ----------- | ---------------------------------------------- | ----------------------------------------------- |
| `id`         | TEXT        | PK                                             | UUID v4                                         |
| `user_id`    | TEXT        | FK → users.id, NOT NULL                        | User affected                                   |
| `event_type` | TEXT        | NOT NULL, CHECK IN ('bind', 'revoke', 'merge') | What happened                                   |
| `payload`    | JSONB       | NOT NULL                                       | Event details (provider, external_id, evidence) |
| `created_at` | TIMESTAMPTZ | NOT NULL, DEFAULT NOW()                        | When the event occurred                         |

**Indexes:** `user_bindings(user_id)` — for lookup by user.

**Trigger:** `reject_identity_events_mutation` — rejects UPDATE/DELETE on `identity_events` (same pattern as ledger append-only triggers).

**Table:** `link_transactions` (server-side, fail-closed account linking)

| Column        | Type        | Constraints                                        | Description                                         |
| ------------- | ----------- | -------------------------------------------------- | --------------------------------------------------- |
| `id`          | TEXT        | PK                                                 | UUID v4                                             |
| `user_id`     | TEXT        | FK → users.id, NOT NULL                            | User initiating the link                            |
| `provider`    | TEXT        | NOT NULL, CHECK IN ('github', 'discord', 'google') | Target provider (wallet excluded — linked via SIWE) |
| `expires_at`  | TIMESTAMPTZ | NOT NULL                                           | 5-minute TTL from creation                          |
| `consumed_at` | TIMESTAMPTZ |                                                    | NULL = pending, set = consumed                      |
| `created_at`  | TIMESTAMPTZ | NOT NULL, DEFAULT NOW()                            | When the transaction was created                    |

**Consume pattern:** Single atomic `UPDATE ... SET consumed_at = now() WHERE id = $txId AND user_id = $userId AND provider = $provider AND consumed_at IS NULL AND expires_at > now() RETURNING *`. The `provider` match prevents cross-provider replay. No separate SELECT — no TOCTOU race. Uses `getServiceDb()` (BYPASSRLS) because the session is not settled during OAuth callback.

**Table:** `user_profiles` (1:1 with users)

| Column         | Type        | Constraints             | Description                  |
| -------------- | ----------- | ----------------------- | ---------------------------- |
| `user_id`      | TEXT        | PK, FK → users.id       | Exactly one profile per user |
| `display_name` | TEXT        | CHECK length ≤ 50       | User-chosen display name     |
| `avatar_color` | TEXT        | CHECK hex `#RRGGBB`     | Avatar background color      |
| `updated_at`   | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Last profile update          |

### Display Name Fallback

When resolving a display name for UI, the fallback chain is:

1. `user_profiles.display_name` (user-chosen)
2. `provider_login` from any `user_bindings` row (OAuth username)
3. Truncated `wallet_address` (e.g., `0x1234…abcd`)
4. `"Anonymous"`

Implemented in `src/app/_facades/users/profile.server.ts:resolveDisplayName()`.

**NO_AUTO_MERGE enforcement:** `UNIQUE(provider, external_id)` on `user_bindings`. Inserting a binding where that provider+external_id is already linked to a different user is a constraint violation at the DB level. No application-level race conditions.

### File Pointers

| File                                                                              | Purpose                                                                     |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/db-schema/src/identity.ts`                                              | `user_bindings` + `identity_events` + `linkTransactions` table definitions  |
| `packages/db-schema/src/profile.ts`                                               | `user_profiles` table definition                                            |
| `src/app/_facades/users/profile.server.ts`                                        | Profile read/update facade, display name fallback chain                     |
| `src/contracts/users.profile.v1.contract.ts`                                      | Zod contracts for `/api/v1/users/me`                                        |
| `src/auth.ts`                                                                     | NextAuth config, signIn callback, link tx create/consume helpers            |
| `src/proxy.ts`                                                                    | Server-side auth routing (single authority for redirects)                   |
| `src/adapters/server/identity/create-binding.ts`                                  | Atomic binding + identity_event insert (idempotent)                         |
| `packages/node-contracts/src/identity.attestation.v1.contract.ts`                 | Frozen operator↔node request/claims protocol and fingerprint               |
| `nodes/operator/app/src/features/identity/services/issue-identity-attestation.ts` | Operator issuance and registered-origin policy                              |
| `nodes/operator/app/src/adapters/server/identity/identity-attestation.adapter.ts` | Operator node-registry read + Ed25519 signing (touches no user data)        |
| `nodes/operator/app/src/app/(app)/identity/attest/route.ts`                       | Broker entry: validates the node request, then starts GitHub authorization  |
| `nodes/operator/app/src/app/api/v1/public/identity/attest/callback/route.ts`      | GitHub authorization response: state match + code exchange, token discarded |
| `nodes/operator/app/src/app/(app)/identity/attest/confirm/page.tsx`               | Explicit account-intent gate — names the resolved login and asking node     |
| `nodes/operator/app/src/app/api/v1/public/identity/attest/confirm/route.ts`       | Terminal leg: confirm signs; switch re-authorizes; cancel clears state      |
| `nodes/operator/app/src/shared/identity/github-oauth.ts`                          | Authorize URL (`prompt=select_account`, empty scope, S256) + code exchange  |
| `nodes/operator/app/src/shared/identity/broker-state.ts`                          | Signed HttpOnly cookie carrying one in-flight broker request                |
| `src/shared/auth/session.ts`                                                      | `SessionUser` type (id + nullable walletAddress)                            |
| `src/shared/auth/link-intent-store.ts`                                            | Discriminated union types + AsyncLocalStorage for link intent               |
| `src/app/api/auth/[...nextauth]/route.ts`                                         | JWT decode → pending/failed intent via AsyncLocalStorage                    |
| `src/app/api/auth/link/[provider]/route.ts`                                       | Link initiation: DB insert + signed JWT cookie + redirect                   |
| `src/lib/auth/server.ts`                                                          | `getServerSessionUser()` — requires only `id`                               |

## DID Readiness (P2)

The DID research (spike.0080) remains valid — deferred until federation is needed:

- **Subject DID**: `did:key` from ed25519 keypair added as optional `subject_did` column on `users`. Not the PK.
- **Wallet DID**: `did:pkh:eip155:{chainId}:{address}` — deterministic from wallet binding. Added where wallet binding exists.
- **VC format**: JWT VC via `did-jwt-vc`. Bindings become exportable VC-shaped artifacts.
- **PEX**: Presentation Exchange semantics for cross-node verification at federation time.

The `user_id` (UUID) remains the ledger key even after DID arrives. DID is an alias for portability, not a replacement.

## Acceptance Checks

**Automated:**

```bash
pnpm check        # types + lint (SessionUser changes compile)
pnpm test          # unit tests pass (binding tests, auth callback tests)
pnpm check:docs    # docs metadata valid
```

**Manual / Stack Test:**

1. New user SIWE login → `users` row created with UUID, `walletAddress` populated
2. Same SIWE login → `user_bindings` row with provider=wallet, external_id=address (idempotent)
3. OAuth login (GitHub/Discord/Google) → new user, `walletAddress` is null
4. Same OAuth login again → same user returned via binding lookup
5. Attempt to bind an external_id already bound to another user → constraint error (NO_AUTO_MERGE)
6. Account linking: authenticated user → OAuth → binding created for existing user
7. Existing SIWE login/logout/switch flows unbroken
8. `identity_events` has a `bind` event for each new binding
9. OAuth-only user hits payment endpoint → clean 403 (WalletRequiredError)

## Open Questions

- [x] Backfill strategy: CTE + RETURNING migration in 0013 — idempotent, events only for inserted bindings.
- [ ] Future: when RBAC actor type migrates from `user:{walletAddress}` to `user:{userId}`, does it happen in this spec or as an RBAC spec update?

## Related

- [Authentication](./authentication.md) — SIWE flow, WALLET_SESSION_COHERENCE invariant
- [RBAC](./rbac.md) — actor type `user:{walletAddress}` will migrate to `user:{userId}`
- [User Context](./user-context.md) — `opaqueId` will derive from user_id
- [Accounts Design](./accounts-design.md) — billing identity references
- [Security Auth](./security-auth.md) — auth surface identity resolution
- [proj.transparent-credit-payouts](../../work/projects/proj.transparent-credit-payouts.md) — ledger consumer of user_id
