// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/compute.akash-tx.v1`
 * Purpose: Wire contract for the private Akash transaction actuator — the typed workload
 *   contract Crossplane's provider-http posts to for observe/create/update/delete (task.5095).
 * Scope: Request/response schemas only. This surface is CLUSTER-PRIVATE: it is never mounted
 *   on the public operator app, and the public compute mutation routes stay tombstoned.
 * Invariants:
 *   - SERVER_OWNS_THE_TRANSACTION: callers supply a logical spec and a `cogniKey`; escrow,
 *     bids, providers, SDL and dseq never appear on this wire.
 *   - STRICT_INPUT: every object is strict — an unexpected key is a 400, never a silent drop
 *     of a field the caller believed was honoured.
 *   - KEY_IS_REQUIRED_ON_EVERY_MUTATION: there is no anonymous create.
 *   - MIGRATION_IS_NOT_A_PAYMENT_PRECONDITION (task.5135): `migration` is NOT a field of the
 *     paid transaction. Renting compute has nothing to prove about a database, and making a DB
 *     Job a precondition of a Console POST is what let node toks5 sit with a valid XR, a valid
 *     digest, and NO LEASE IN ANY ENVIRONMENT while `akash-lease` said "not yet ready" 1044
 *     times. Migration is now stated on OBSERVE — the unpaid, level-triggered tick — as
 *     `AkashTxMigrationStepSchema`, and its outcome is REPORTED, never enforced. A workload
 *     whose schema is missing therefore fails READINESS (bounded by the XRD's
 *     `bootPolicy.bootDeadlineSeconds`) instead of never being created at all.
 *   - MIGRATION_ON_MUTATION_IS_DEPRECATED: create/update still ACCEPT a `migration` object so a
 *     Composition that has not yet been rematerialized cannot 400 the whole fleet mid-rollout
 *     (the same zero-downtime posture the XRD uses for the task.5122 lease-generation rename:
 *     the old field stays SERVED and READ while nothing writes it, until every deploy ref has
 *     been rematerialized). It is parsed and
 *     IGNORED. Remove the field once every deploy ref carries `migration.policy:
 *     RequireBeforeServing`.
 *   - IDENTITY_IS_REQUIRED_ON_EVERY_MUTATION: `identity` is a REQUIRED field on create and
 *     update. A caller that will not say WHICH NODE consumes the infrastructure gets a 400 —
 *     it can never accidentally buy an unattributable lease (task.5103). Identity is stated,
 *     never derived: the actuator does not parse `cogniKey`, does not read the workload slug,
 *     and does not infer a node from the Console credential.
 * Side-effects: none (schemas only)
 * Links: src/features/compute/akash-tx/akash-tx-http.ts, @ports/akash-tx.port, task.5095,
 *   task.5103
 * @public
 */

import { z } from "zod";

/** DNS-safe service name inside a workload. */
const ServiceNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "service name must be DNS-safe");

export const AkashTxExposeSchema = z.strictObject({
  port: z.number().int().positive(),
  as: z.number().int().positive(),
  global: z.boolean(),
  hosts: z.array(z.string().min(1)).optional(),
});

export const AkashTxServiceSpecSchema = z.strictObject({
  name: ServiceNameSchema,
  image: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  command: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  cpuUnits: z.number().positive(),
  memoryMi: z.number().int().positive(),
  storageMi: z.number().int().positive(),
  expose: z.array(AkashTxExposeSchema).optional(),
});

/** `sha256:<64 hex>` — the immutable bundle digest a migration is keyed by. */
const BundleDigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "expected a sha256 bundle digest");

/**
 * THE RELEASE-SIDE MIGRATION STEP (task.5135). Stated on OBSERVE — the unpaid, level-triggered
 * tick Crossplane already runs on every reconcile — and NEVER on a paid mutation.
 *
 * The block's PRESENCE is the whole policy: a workload with a database sends it, one without
 * omits it. There is no `policy` discriminator here on purpose, because the only thing a policy
 * could still select is "run it or don't", and that is exactly what presence already says. The
 * XRD keeps `spec.migration.policy` as the operator-facing declaration; the Composition lowers
 * it to presence-or-absence of this block.
 *
 * The migration COMMANDS remain deliberately absent — a caller-supplied command would let any
 * caller pass a no-op; `profile` selects a command set the actuator owns.
 */
export const AkashTxMigrationStepSchema = z.strictObject({
  profile: z.literal("cogni-node-app-v1"),
  bundleDigest: BundleDigestSchema,
  image: z.string().min(1).max(512),
  /** True when the app service declares a `DOLTGRES_URL` secret ref. */
  doltgres: z.boolean(),
});

/** What the release step is doing for this digest right now. Reported, never enforced. */
export const AkashTxMigrationPhaseSchema = z.enum([
  "succeeded",
  "running",
  "failed",
  /** The actuator has no migration capability wired, so the step could not be attempted. */
  "unavailable",
]);

/**
 * DEPRECATED compatibility shape for the create/update wire (task.5135). The actuator parses
 * and IGNORES it. It remains served only so a Composition rendered before the rematerialize
 * cannot 400 the fleet mid-rollout — the same zero-downtime posture the XRD uses for the
 * task.5122 lease-generation rename. New callers must not send it.
 *
 * Kept LOOSE on purpose: this is a field on its way out, and strictly re-validating a value
 * nothing reads would only invent new ways for an old caller to fail.
 */
export const AkashTxDeprecatedMigrationSchema = z.object({
  policy: z.enum(["Skip", "RequireBeforeTransaction", "RequireBeforeServing"]),
});

/** The provider-agnostic workload contract (mirrors ProvisionSpec). */
export const AkashTxSpecSchema = z.strictObject({
  name: ServiceNameSchema,
  services: z.array(AkashTxServiceSpecSchema).min(1),
});

/** Caller-owned idempotency key. Must embed the caller's resource revision. */
const CogniKeySchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9._:/-]+$/, "cogniKey must be url-safe");

/**
 * WHO CONSUMED the infrastructure, as the Composition must state it. Mirrors XComputeWorkload's
 * `spec.nodeId` (itself `format: uuid` and immutable) plus the composite's own `metadata.uid`
 * and `metadata.generation`.
 *
 * `nodeId` is a strict UUID because it is the cost-grouping key and the receipt column is
 * `uuid` — a malformed value must be a 400 at the wire, not a database error mid-transaction.
 * `compositeUid` is deliberately opaque and only length/charset-bounded: the actuator binds
 * it, it does not interpret Kubernetes internals.
 *
 * NOT here, and deliberately: wallet scope (custody — the actuator resolves its own wallet and
 * a caller must never be able to name one), billing account, DAO address, and user/actor. v0 is
 * operator-sponsored; those four are separate facts and none substitutes for `nodeId`.
 */
export const AkashTxIdentitySchema = z.strictObject({
  nodeId: z.string().uuid(),
  compositeUid: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/, "compositeUid must be url-safe"),
  compositeGeneration: z.number().int().positive(),
});

const ExternalNameSchema = z.string().min(1).max(128);
const EnvironmentSchema = z.string().min(1).max(64);
const SourceShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "expected a full sha");

/**
 * Observe is the UNPAID tick: no wallet slot, no Console POST, no ledger claim. That is exactly
 * why the release-side migration step rides here and not on create/update — asking a question
 * about a database can never be a reason not to rent a computer.
 */
export const AkashTxObserveInputSchema = z.strictObject({
  cogniKey: CogniKeySchema,
  externalName: ExternalNameSchema.optional(),
  expectedSourceSha: SourceShaSchema.optional(),
  /**
   * The workload's public hostname. When present, the serving probe must prove the exact
   * SHA through the provider's host-routed path too — the bare lease ingress alone cannot
   * see a stale deployment still owning the hostname (bug.5237).
   */
  publicHost: z.string().min(1).max(253).optional(),
  migration: AkashTxMigrationStepSchema.optional(),
  /**
   * WHOSE database the attached migration step belongs to. Required in practice whenever
   * `migration` is sent — the actuator refuses to infer either from `cogniKey` or from its own
   * deployment, because inferring them is how "which environment's DB?" became a payment-plane
   * question in the first place. Optional on the schema so an observe WITHOUT a migration stays
   * byte-identical to the pre-task.5135 wire.
   */
  workload: ServiceNameSchema.optional(),
  environment: EnvironmentSchema.optional(),
});

export const AkashTxCreateInputSchema = z.strictObject({
  cogniKey: CogniKeySchema,
  environment: EnvironmentSchema,
  identity: AkashTxIdentitySchema,
  spec: AkashTxSpecSchema,
  /** DEPRECATED, parsed and ignored — see `AkashTxDeprecatedMigrationSchema`. */
  migration: AkashTxDeprecatedMigrationSchema.optional(),
});

/**
 * An update replaces the SDL in place and mints no lease, but it is still a mutation of a PAID
 * resource — so it states its identity, and the actuator refuses it when the durable receipt
 * for the key binds a different node.
 */
export const AkashTxUpdateInputSchema = z.strictObject({
  cogniKey: CogniKeySchema,
  externalName: ExternalNameSchema,
  environment: EnvironmentSchema,
  identity: AkashTxIdentitySchema,
  spec: AkashTxSpecSchema,
  /** DEPRECATED, parsed and ignored — see `AkashTxDeprecatedMigrationSchema`. */
  migration: AkashTxDeprecatedMigrationSchema.optional(),
});

export const AkashTxDeleteInputSchema = z.strictObject({
  cogniKey: CogniKeySchema,
  externalName: ExternalNameSchema,
});

/**
 * Lease-log source enumeration (bug.5240). Unlike the four Crossplane ops above, this wire
 * DELIBERATELY exposes lease coordinates (dseq/gseq/oseq/provider): its caller is the
 * lease-log-pump, whose whole job is reading provider logs, and the coordinates plus a
 * logs-scoped ephemeral JWT are exactly the least capability that job needs.
 */
export const AkashTxLeaseLogSourcesInputSchema = z.strictObject({
  environment: EnvironmentSchema.optional(),
  limit: z.number().int().min(1).max(64).optional(),
});

export const AkashTxLeaseLogSourceSchema = z.strictObject({
  nodeId: z.string().uuid(),
  workload: z.string().min(1).max(64),
  environment: EnvironmentSchema,
  dseq: z.string().min(1).max(32),
  gseq: z.number().int().positive(),
  oseq: z.number().int().positive(),
  providerAccount: z.string().min(1).max(64),
  providerHostUri: z.string().url(),
  services: z.array(z.string().min(1).max(64)).max(16),
});

export const AkashTxLeaseLogSourcesOutputSchema = z.strictObject({
  sources: z.array(AkashTxLeaseLogSourceSchema).max(64),
  /** Logs-scoped provider JWT covering every source. Empty when `sources` is empty. */
  token: z.string(),
  ttlSeconds: z.number().int().nonnegative(),
});

export const AkashTxResourceSchema = z.strictObject({
  externalName: z.string(),
  state: z.enum(["pending", "active", "closed", "unknown"]),
  endpoints: z.array(z.string()),
  providerAccount: z.string().optional(),
});

export const AkashTxObserveOutputSchema = z.strictObject({
  found: z.boolean(),
  resource: AkashTxResourceSchema.optional(),
  serving: z.boolean().optional(),
  recovered: z.boolean().optional(),
  /**
   * Outcome of the release-side migration step for this digest, when the caller asked for one.
   * REPORTED, never enforced: the composite turns a `failed` phase into a named status reason,
   * and a workload whose schema never arrives fails its boot SLO — which is BOUNDED — instead
   * of never being created at all, which was not.
   */
  migration: z.strictObject({ phase: AkashTxMigrationPhaseSchema }).optional(),
});

export const AkashTxCreateOutputSchema = AkashTxResourceSchema.extend({
  replayed: z.boolean(),
  recovered: z.boolean(),
});

export const AkashTxErrorOutputSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  ownerCogniKey: z.string().optional(),
});

export type AkashTxMigrationStep = z.infer<typeof AkashTxMigrationStepSchema>;
export type AkashTxMigrationPhase = z.infer<typeof AkashTxMigrationPhaseSchema>;
export type AkashTxIdentity = z.infer<typeof AkashTxIdentitySchema>;
export type AkashTxObserveInput = z.infer<typeof AkashTxObserveInputSchema>;
export type AkashTxLeaseLogSourcesInput = z.infer<
  typeof AkashTxLeaseLogSourcesInputSchema
>;
export type AkashTxCreateInput = z.infer<typeof AkashTxCreateInputSchema>;
export type AkashTxUpdateInput = z.infer<typeof AkashTxUpdateInputSchema>;
export type AkashTxDeleteInput = z.infer<typeof AkashTxDeleteInputSchema>;
