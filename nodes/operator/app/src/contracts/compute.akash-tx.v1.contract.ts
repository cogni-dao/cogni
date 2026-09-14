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
 *   - MIGRATION_IS_REQUIRED_ON_EVERY_MUTATION: `migration` is a REQUIRED field on create and
 *     update. A caller that does not state its migration precondition gets a 400 — it can
 *     never accidentally inherit an ungated paid lease (bug.5140). `Skip` is the one explicit,
 *     auditable bypass, and it has to be written down.
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

/**
 * The caller's migration precondition (bug.5116 order, bug.5140 enforcement). Mirrors the
 * XRD's `spec.migration.policy` plus the facts the actuator needs to PROVE it.
 *
 * A discriminated union, not an object with optional fields: `RequireBeforeTransaction`
 * structurally cannot be sent without the digest and image whose migration must be proven, so
 * an under-specified request is a 400 rather than a silently ungated paid lease. The migration
 * COMMANDS are deliberately absent — a caller-supplied command would let any caller "prove" a
 * migration by passing a no-op; `profile` selects a command set the actuator owns.
 */
export const AkashTxMigrationSchema = z.discriminatedUnion("policy", [
  /** The workload has no database. The only legitimate bypass, and it is explicit. */
  z.strictObject({ policy: z.literal("Skip") }),
  z.strictObject({
    policy: z.literal("RequireBeforeTransaction"),
    profile: z.literal("cogni-node-app-v1"),
    bundleDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/, "expected a sha256 bundle digest"),
    image: z.string().min(1).max(512),
    /** True when the app service declares a `DOLTGRES_URL` secret ref. */
    doltgres: z.boolean(),
  }),
]);

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

export const AkashTxObserveInputSchema = z.strictObject({
  cogniKey: CogniKeySchema,
  externalName: ExternalNameSchema.optional(),
  expectedSourceSha: SourceShaSchema.optional(),
});

export const AkashTxCreateInputSchema = z.strictObject({
  cogniKey: CogniKeySchema,
  environment: EnvironmentSchema,
  identity: AkashTxIdentitySchema,
  spec: AkashTxSpecSchema,
  migration: AkashTxMigrationSchema,
});

/**
 * An update replaces the SDL in place — it mints no lease — but it is still the call that puts
 * a NEW bundle digest in front of the node's database, which is exactly what bug.5116 ordered.
 * The legacy gate ran before every provider mutation, so this one carries the requirement too.
 * An update replaces the SDL in place and mints no lease, but it is still a mutation of a PAID
 * resource — so it states its identity too, and the actuator refuses it when the durable
 * receipt for the key binds a different node.
 */
export const AkashTxUpdateInputSchema = z.strictObject({
  cogniKey: CogniKeySchema,
  externalName: ExternalNameSchema,
  environment: EnvironmentSchema,
  identity: AkashTxIdentitySchema,
  spec: AkashTxSpecSchema,
  migration: AkashTxMigrationSchema,
});

export const AkashTxDeleteInputSchema = z.strictObject({
  cogniKey: CogniKeySchema,
  externalName: ExternalNameSchema,
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

export type AkashTxMigration = z.infer<typeof AkashTxMigrationSchema>;
export type AkashTxIdentity = z.infer<typeof AkashTxIdentitySchema>;
export type AkashTxObserveInput = z.infer<typeof AkashTxObserveInputSchema>;
export type AkashTxCreateInput = z.infer<typeof AkashTxCreateInputSchema>;
export type AkashTxUpdateInput = z.infer<typeof AkashTxUpdateInputSchema>;
export type AkashTxDeleteInput = z.infer<typeof AkashTxDeleteInputSchema>;
