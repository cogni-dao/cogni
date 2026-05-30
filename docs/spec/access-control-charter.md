---
id: spec.access-control-charter
type: spec
title: Access Control Charter — Layered Authority Model
status: draft
spec_state: proposed
trust: draft
summary: One-page index of the six layers — Identity, AuthN, AuthZ, Secrets, Governance/DAO, Operator Plane — that compose Cogni's access-control surface. Each layer has a canonical spec; this document defines the dependency arrows so phased work doesn't ship out of order.
read_when: Designing across layers (e.g., RBAC against OpenBao paths, governance decisions that bind secrets, multi-tenant features). Reviewing any work that crosses two of the layers below. Before writing a new spec that touches identity, auth, or secrets.
owner: derekg1729
created: 2026-05-27
verified: 2026-05-27
tags:
  - identity
  - authentication
  - authorization
  - secrets
  - governance
  - charter
---

# Access Control Charter

## Goal

Provide a single one-page map of how Cogni's access-control surface composes — Identity → AuthN → AuthZ → Secrets → DAO → Operator Plane — so phased work ships in dependency order and cross-layer features don't accidentally assume capabilities that aren't yet wired.

## Non-Goals

- Inventing new access-control mechanisms. Every layer below points at a canonical spec that owns its design.
- Defining the runtime enforcement model for any single layer — those specs already exist.
- Replacing `identity-model.md` or any other sibling spec. This file references them.

## Context

Cogni has well-developed specs for identity, authentication, authorization, secrets, and DAO governance. **What it does not have** is a single map showing how those layers compose, which depends on which, and where the seams between them live. Without that map, phased work ships out of order: a feature that assumes RBAC enforcement lands before the OpenFGA adapter is wired; a secret-scoping feature lands before the identity migration. This document is the map.

It is not a new spec. Every load-bearing claim points at an existing canonical spec; this file only defines the **layer cake**, the **dependency arrows**, and the **boundary contracts** between layers.

## Design

### The layer cake

```
┌─────────────────────────────────────────────────────────────────────┐
│  L5  OPERATOR PLANE                                                 │
│      Cross-cutting admin surface. Who can deploy a node, mint a     │
│      tenant, rotate a substrate token, manage RBAC, run governance  │
│      execution under a system tenant.                               │
│      Canonical: node-operator-contract.md, system-tenant.md         │
└─────────────────────────────────────────────────────────────────────┘
                              ▲
                              │  delegates to / executes via
                              │
┌─────────────────────────────────────────────────────────────────────┐
│  L4  GOVERNANCE / DAO                                               │
│      On-chain authority binding. scope_id → dao_address; PR review  │
│      → proposal → vote → GitHub action. Multi-scope payout rails.   │
│      Canonical: dao-enforcement.md, dao-governance-loop.md,         │
│                 governance-signal-execution.md                      │
└─────────────────────────────────────────────────────────────────────┘
                              ▲
                              │  enforces decisions over
                              │
┌─────────────────────────────────────────────────────────────────────┐
│  L3  SECRETS                                                        │
│      Every credential consumed at runtime. OpenBao SSOT + ESO        │
│      delivery for k8s; today GH env → .env for Compose-infra        │
│      (migration path documented separately).                         │
│      Canonical: secrets-management.md, secrets-classification.md    │
└─────────────────────────────────────────────────────────────────────┘
                              ▲
                              │  access gated by
                              │
┌─────────────────────────────────────────────────────────────────────┐
│  L2  AUTHORIZATION (AuthZ)                                          │
│      What an authenticated subject can do. Tool gating, connection  │
│      authorization, capability injection, RBAC actor/subject model. │
│      Canonical: rbac.md, tool-use.md, tenant-connections.md         │
└─────────────────────────────────────────────────────────────────────┘
                              ▲
                              │  resolves to user_id via
                              │
┌─────────────────────────────────────────────────────────────────────┐
│  L1  AUTHENTICATION (AuthN)                                         │
│      How a request becomes a user_id. SIWE wallet + OAuth providers │
│      (GitHub, Discord, Google), NextAuth v4, account linking via    │
│      user_bindings.                                                 │
│      Canonical: authentication.md, decentralized-user-identity.md   │
└─────────────────────────────────────────────────────────────────────┘
                              ▲
                              │  references keys defined in
                              │
┌─────────────────────────────────────────────────────────────────────┐
│  L0  IDENTITY                                                       │
│      The six orthogonal keys: node_id, scope_id, user_id, actor_id, │
│      billing_account_id, dao_address. Defines the vocabulary every  │
│      layer above uses.                                              │
│      Canonical: identity-model.md                                   │
└─────────────────────────────────────────────────────────────────────┘
```

### Layer contracts (what each layer guarantees to the layer above)

| Layer                 | Provides                                                                                                                    | Consumes from below                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L0 Identity**       | A stable vocabulary of six orthogonal keys with prohibited-overloading invariants.                                          | —                                                                                                                                                              |
| **L1 AuthN**          | A `user_id` (UUID) for every authenticated request, plus a SIWE-only `walletAddress` attribute. Session coherence for SIWE. | L0 keys.                                                                                                                                                       |
| **L2 AuthZ**          | A boolean decision for `(actor, action, resource)` tuples. Tool-execution gating. Connection-credential gating.             | L0 keys + L1 `user_id` → resolves actor identity.                                                                                                              |
| **L3 Secrets**        | A populated env var inside a pod (or a value rendered to `.env` on a Compose host). Audit trail of every read/write.        | L2 path-policy decisions for `eso-reader` / `<env>-writer` (today); future tenant-scoped paths governed by L2 (`cogni/<env>/_tenants/<billing_account_id>/*`). |
| **L4 Governance/DAO** | An on-chain signal that authorizes a code or payout action. Multi-scope payment rails.                                      | L0 `scope_id` ↔ `dao_address` binding; L1 wallet identity for proposers.                                                                                      |
| **L5 Operator Plane** | Substrate provisioning, tenant lifecycle, system-tenant execution context for governance agents.                            | All of L1–L4. Operator is a privileged consumer, not a peer.                                                                                                   |

## Invariants

### Cross-layer invariants

These are the rules that span layers and would otherwise be missed by looking at any single spec.

1. **AUTHZ_NOT_AUTHN.** L2 RBAC actor type is `user:{user_id}` once identity ships. Today `rbac.md` acknowledges a `user:{walletAddress}` transitional shape — that migration is L1 → L2 and must happen before L2 enforcement leaves draft.

2. **SECRETS_PATH_IS_AN_AUTHZ_RESOURCE.** `secrets-management.md` Invariant 6 (RBAC_VIA_PATH_POLICY) defines OpenBao path policies as a separate-but-equivalent RBAC system to L2. They are not unified today. Any future tenant-scoped secret path (`cogni/<env>/_tenants/<billing_account_id>/*`) MUST resolve through L2 — do not invent a second authorization layer inside OpenBao policy HCL.

3. **DAO_AUTHORITY_IS_NOT_L2.** L4 DAO governance authorizes code merges and payouts via on-chain signals; it does NOT authorize runtime requests. A user with DAO voting rights has no special L2 permission by default. The two layers intentionally never intersect at the request-handler level.

4. **OPERATOR_PLANE_RUNS_AS_SYSTEM_TENANT.** L5 operator actions that produce side effects (deploys, secret rotations, governance execution) are attributed to the `cogni_system` tenant defined in `system-tenant.md`. Operator actions are NOT attributed to the human triggering them — that's an L1-vs-L5 distinction that prevents user impersonation by privileged automation.

5. **NO_ROOT_TOKEN_POST_BOOTSTRAP.** L3 Invariant 13 (NO_OPERATOR_ROOT_TOKEN_ON_LAPTOP) is a hard L5 boundary. After Phase 5b of `provision-env-vm.sh`, the operator plane writes secrets via short-lived writer-JWT only. Re-exporting the bootstrap root token IS the failure mode this charter exists to prevent.

## Phased work ordering (read in conjunction with `task.5062` runbook)

The dependency arrows above dictate the order in which capabilities can ship:

| Phase  | Lands                                                                                       | Hard dependency | Why this order                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0** | L3 substrate (OpenBao + ESO) + L0 identity model — both in node-template                    | —               | Foundational. L0 is already-written spec; L3 is `task.0284` substrate.                                                                               |
| **P1** | L3 live-VM E2E validation (`task.5062`)                                                     | P0              | Substrate must be proven before downstream ports inherit it.                                                                                         |
| **P2** | L2 RBAC v0 (`proj.rbac-hardening`)                                                          | L0 only         | Enforcement layer comes online; uses `user:{walletAddress}` transitional shape. **Can ship in parallel with P1** — RBAC doesn't touch ESO substrate. |
| **P3** | L1 identity migration completes + L2 actor type migrates to `user:{user_id}`                | P2              | Closes AUTHZ_NOT_AUTHN. Order matters: L1 must publish stable `user_id` BEFORE L2 can rely on it.                                                    |
| **P4** | L5 system-tenant ships (`proj.system-tenant-governance`); operator-plane actions attributed | P2              | Closes OPERATOR_PLANE_RUNS_AS_SYSTEM_TENANT. Depends on L2 to gate operator actions.                                                                 |
| **P5** | L3 multi-tenant secret paths + tenant-scoped OpenBao policies governed by L2                | P1 + P2         | Closes SECRETS_PATH_IS_AN_AUTHZ_RESOURCE. Depends on substrate being proven AND L2 enforcement being live.                                           |
| **P6** | L4 DAO governance loop fully wired into production (multi-scope payout enforcement)         | P4              | Independent of L1–L3 at the request-handler level; depends on L5 for execution.                                                                      |

**Parallelism map:** P1 and P2 can ship concurrently — P1 is L3-only, P2 is L0+L2 only, they share no critical path. P5 is the first phase that requires BOTH branches converged. Compose-infra → OpenBao migration lives entirely within L3 and can ship any time after P1.

## SOC2 readiness status

Score against the top-0.1% reference stack (HashiCorp Vault production reference architecture + CNCF cloud-native security guidance + NIST 800-53 AC/AU/SC control families). Updated when any 🔴 row closes.

```
   ┌─────────────────────────────────────────────────────────────────┐
   │  OUR STACK            │  TOP-0.1% STACK                │ STATUS │
   ├───────────────────────┼────────────────────────────────┼────────┤
   │  OpenBao (Vault fork) │  Vault / OpenBao / hosted KMS  │   🟢   │
   │  External Secrets Op  │  External Secrets Op (CNCF)    │   🟢   │
   │  OpenFGA RBAC         │  OpenFGA / Cedar               │   🟢   │
   │  envFrom secretRef    │  envFrom secretRef             │   🟢   │
   │  Loki audit pipeline  │  Loki  +  tamper-evident sink  │   🔴   │
   │  Shamir keys on disk  │  Cloud KMS auto-unseal         │   🔴   │
   │  Static DB passwords  │  Vault DB engine (1h TTL)      │   🔴   │
   │  K8s SA JWT auth      │  SPIFFE/SPIRE (preferred)      │   🟡   │
   │  Quarterly access rev │  SCIM + JIT elevation          │   🟡   │
   │  FIPS 140-2 crypto    │  Vault Enterprise / Cloud KMS  │   🟡   │
   └───────────────────────┴────────────────────────────────┴────────┘
   🟢 = aligned     🟡 = OK today, document tradeoff     🔴 = audit-blocking
```

### Audit-blocking gaps (🔴)

| Gap                                                                | Why it blocks a SOC2 Type II audit                                               | Task                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Cloud KMS auto-unseal — eliminate `.local/<env>-openbao-init.json` | CC6.1 — unseal keys must not sit on operator laptops                             | [`task.5065`](https://cognidao.org/work/items/task.5065) |
| WORM / Object-Lock audit sink alongside Loki                       | CC7.2 + CC8.1 — Loki alone is mutable; auditor needs tamper-evident copy         | [`task.5066`](https://cognidao.org/work/items/task.5066) |
| Dynamic DB credentials via OpenBao DB engine                       | CC6.1 — long-lived `APP_DB_PASSWORD` fails "when was this last rotated" question | [`task.5067`](https://cognidao.org/work/items/task.5067) |

### Acceptable tradeoffs to document (🟡)

| Gap                                  | Why deferred                                                    | When to revisit                                                                          |
| ------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| SPIFFE/SPIRE workload identity       | K8s SA JWT is HashiCorp-recommended for k8s-only stacks         | Lands when Compose→OpenBao migration crosses substrate boundary                          |
| Quarterly access review (SCIM + JIT) | No IdP integration yet; small org                               | When org grows past ~10 humans or first enterprise tenant asks                           |
| FIPS 140-2 validated crypto          | OpenBao CE is not FIPS-validated; not required for vanilla SOC2 | Migrate to Vault Enterprise or AWS KMS if a tenant needs FedRAMP / financial attestation |

### Aligned with top-tier (🟢)

We are NOT meaningfully reinventing wheels. Every primitive in the current stack — OpenBao, ESO, OpenFGA, Kubernetes auth method, KV v2 versioning, NIST 800-57 key-lifecycle vocabulary — is the canonical choice for a Vault-class SOC2 deployment. The 🔴 rows are vendor-blessed additions to OpenBao, not parallel systems.

## Open questions

- [ ] L3 multi-tenant secret paths: should `cogni/<env>/_tenants/<billing_account_id>/*` live alongside `cogni/<env>/<service>/*`, or under it? Resolution gates P5.
- [ ] L4 multi-scope payout enforcement: which entity at runtime asserts that a payout originates from the correct `scope_id`'s DAO treasury? Resolution gates P6.
- [ ] L5 operator-plane RBAC: today operator actions are gated by "who has the GitHub App installed" — a coarse permission model. Should L5 gain its own OpenFGA model, or extend L2? Resolution gates P4.

## Related

- [Identity Model](./identity-model.md) — L0 canonical
- [Authentication](./authentication.md) — L1 canonical
- [Decentralized User Identity](./decentralized-user-identity.md) — L1 bindings
- [RBAC](./rbac.md) — L2 canonical
- [Tool Use](./tool-use.md) — L2 enforcement at tool boundary
- [Tenant Connections](./tenant-connections.md) — L2 enforcement at credential boundary
- [Secrets Management](./secrets-management.md) — L3 canonical
- [Secrets Classification](./secrets-classification.md) — L3 catalog (which secret routes where)
- [DAO Enforcement](./dao-enforcement.md) — L4 canonical
- [DAO Governance Loop](./dao-governance-loop.md) — L4 end-to-end flow
- [Node vs Operator Contract](./node-operator-contract.md) — L5 canonical
- [System Tenant](./system-tenant.md) — L5 execution context
