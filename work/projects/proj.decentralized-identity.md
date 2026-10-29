---
id: proj.decentralized-identity
type: project
primary_charter:
title: User Identity Bindings + DID Readiness
state: Active
priority: 1
estimate: 4
summary: Unify Discord + GitHub + wallet under a single user_id (UUID). Ledger, receipts, and attribution reference user_id — never wallet. "Contributor" is a derived label, not an identity primitive. DID/VC portability deferred to P2.
outcome: Users identified by stable UUID regardless of auth method; wallet/Discord/GitHub are evidenced bindings; ledger events reference user_id; DID compatibility layer available when cross-node portability is needed.
assignees: derekg1729
created: 2026-02-17
updated: 2026-02-26
labels: [identity, auth, web3, ssi]
---

# User Identity Bindings + DID Readiness

## Goal

Provide a stable, auth-method-agnostic identity for every user. The canonical identifier is `user_id` (UUID, = `users.id`) — not a wallet address, not a DID. Wallet, Discord, and GitHub accounts are evidenced bindings attached to the user, never the identity itself. "Contributor" is a derived label (user has eligible contribution events), not a separate identity primitive. This unblocks the ledger (proj.transparent-credit-payouts) to reference users deterministically. DID/VC standards are adopted later as a portability layer, not as the foundation.

## Roadmap

### Crawl (P0) — User Identity + Bindings

**Goal:** Unify Discord + GitHub + optional wallet under `users.id`. Ledger can attribute work and spend to a user.

| Deliverable                                                                           | Status      | Est | Work Item  |
| ------------------------------------------------------------------------------------- | ----------- | --- | ---------- |
| Research spike: gap analysis + design doc                                             | Done        | 2   | spike.0080 |
| `user_bindings` table + `identity_events` audit trail                                 | In Review   | 2   | task.0089  |
| Multi-provider auth: GitHub + Discord + Google OAuth on NextAuth v4 via user_bindings | In Review   | 3   | task.0107  |
| Backfill: existing `users.wallet_address` → `user_bindings`                           | In Review   | 1   | task.0089  |
| Profile + identity DB correctness: RLS, constraints, type tightening                  | In Review   | 2   | task.0110  |
| Auth UX: SignInDialog, proxy auth routing, fail-closed linking, profile wiring        | In Review   | 3   | task.0111  |
| SIWE zero-flash: immediate post-sign navigation                                       | Not Started | 1   | task.0112  |

**Exit criteria:** You can attribute work + messages to a user, deterministically, with `user_id` as the single stable ID that the ledger references.

### Walk (P1) — Account Linking Hardening

**Goal:** Conflict resolution, merge workflows, and admin tooling for identity bindings. Discord attribution (task.0077) ships `discord_user_id` in billing metadata.

**Prerequisite:** task.0077 (Discord attribution + spend guard) must ship first.

| Deliverable                                               | Status      | Est | Work Item            |
| --------------------------------------------------------- | ----------- | --- | -------------------- |
| Merge workflow: resolve conflicting bindings with proof   | Not Started | 2   | (create at P1 start) |
| Admin tooling: binding review + conflict queue            | Not Started | 2   | (create at P1 start) |
| Revocation flow (append-only status change, never delete) | Not Started | 1   | (create at P1 start) |
| Discord → user_id mapping for credit-gated billing        | Not Started | 2   | (create at P1 start) |

### Run (P2+) — DID/VC Compatibility Layer

**Goal:** Add standards-based artifacts without changing ledger semantics. Adopt when cross-node portability is actually needed.

| Deliverable                                                      | Status      | Est | Work Item            |
| ---------------------------------------------------------------- | ----------- | --- | -------------------- |
| `subject_did` column (did:key) as optional alias on users        | Not Started | 2   | (create at P2 start) |
| `did:pkh` for wallets where wallet binding exists                | Not Started | 1   | (create at P2 start) |
| Represent bindings as VC-shaped artifacts (JWT VC, store+export) | Not Started | 2   | (create at P2 start) |
| PEX verification semantics for federation                        | Not Started | 2   | (create at P2 start) |
| Multi-issuer trust policy (accept credentials from other nodes)  | Not Started | 3   | (create at P2 start) |
| DIDComm evaluation for private inter-node channels               | Not Started | 1   | (create at P2 start) |

## Constraints

- SIWE authentication must continue working uninterrupted throughout all phases
- No blockchain DID registry, Sidetree network, or DIDComm required for P0/P1
- No on-chain reputation tokens or cred contracts in scope
- Discord identifiers must use immutable numeric IDs, never usernames
- All identity state transitions must be append-only; current state is derived
- Binding flows must be idempotent (retries don't create duplicate bindings)
- Raw external identifiers are private by default; not exposed publicly
- Ledger (receipts, epochs, payout statements) references `user_id` — never wallet address or DID directly

## Dependencies

- [x] spike.0080 — design doc landed ([research doc](../../docs/research/did-first-identity-refactor.md))
- [ ] Existing SIWE auth stable (authentication spec — no breaking changes in flight)
- [ ] task.0077 (Discord attribution + spend guard) — ships `discord_user_id` in billing metadata, which P1 maps to user_id for credit-gated billing

## Impacted Specs (Must Update)

These existing specs reference wallet address as identity and will need updates as implementation lands:

- [authentication.md](../../docs/spec/authentication.md) — SIWE session identity
- [security-auth.md](../../docs/spec/security-auth.md) — auth surface identity resolution
- [accounts-design.md](../../docs/spec/accounts-design.md) — `ONE_USER_ONE_BILLING_ACCOUNT` mapping
- [rbac.md](../../docs/spec/rbac.md) — actor type `user:{walletAddress}` → `user:{userId}`
- [user-context.md](../../docs/spec/user-context.md) — `opaqueId` derivation from user_id
- [billing-ingest.md](../../docs/spec/billing-ingest.md) — billing identity references

## Consumer: Transparent Credit Payouts

[proj.transparent-credit-payouts](./proj.transparent-credit-payouts.md) depends on stable user identity:

- `activity_events.user_id` references `users.id` (resolved via `user_bindings`)
- `epoch_allocations` and `payout_statements` keyed by `user_id`
- Identity merges must not rewrite receipt history — new events only

## As-Built Specs

- [user-identity-bindings](https://cognidao.org/knowledge/user-identity-bindings) — user_bindings + identity_events schema, invariants, auth flow
- [authentication](../../docs/spec/authentication.md) — multi-provider auth (SIWE + OAuth), account linking, wallet-session coherence

## Design Notes

### Why user_id (UUID) instead of DID at P0?

1. **DID requires crypto dependencies** (ed25519, multicodec, base58btc) that add complexity with zero user-facing value until federation
2. **Ledger correctness doesn't need DIDs** — it needs stable, unique user IDs. UUID does this.
3. **Discord-first and GitHub-first users** don't have wallets, so `did:pkh` is a dead end as canonical ID
4. **DID is a portability concern**, not an identity correctness concern. Portability matters when federating; correctness matters now.

### Why user_id not contributor_id?

"User" is the stable concept — accounts, billing, sessions, permissions all reference users. "Contributor" is contextual and mutable (a user can exist without contributing). Naming the canonical ID `contributor_id` would leak domain assumptions into every table and API. "Contributor" belongs as a derived label: `is_contributor` if user has eligible contribution events in an epoch.

### DID Readiness (kept from spike.0080)

The spike research remains valid — just deferred to P2. Key decisions preserved:

- **Subject DID**: `did:key` from ed25519 keypair. Auth-method-agnostic. Will be added as optional alias on `users` table.
- **Wallet DID**: `did:pkh` is a _linked_ identifier, not the subject. Deterministic from chain + address.
- **VC format**: JWT VC via `did-jwt-vc`. Simpler than JSON-LD, W3C-compliant, upgrade path exists.
- **No auto-merge**: DB-level unique constraint on bindings prevents silent re-pointing. Same invariant, UUID-based instead of DID-based.

### Critical Invariants

- **I-USER-ID**: Every user has `users.id` (UUID) as canonical identifier. Wallets, Discord, GitHub are bindings — never the identity itself.
- **I-NO-AUTO-MERGE**: If a binding is already attached to a different user, require explicit merge with proofs. Never silently re-point. DB-enforced via `UNIQUE(provider, external_id)`.
- **I-BINDINGS-ARE-EVIDENCED**: Every binding has proof recorded in `identity_events.payload`. Bindings table is current-state index only.
- **I-LEDGER-REFERENCES-USER-ID**: Receipts and payout events reference `user_id`, never wallet address or DID.
