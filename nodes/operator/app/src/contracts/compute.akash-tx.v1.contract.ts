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
 * Side-effects: none (schemas only)
 * Links: src/features/compute/akash-tx/akash-tx-http.ts, @ports/akash-tx.port, task.5095
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
  spec: AkashTxSpecSchema,
});

export const AkashTxUpdateInputSchema = z.strictObject({
  cogniKey: CogniKeySchema,
  externalName: ExternalNameSchema,
  environment: EnvironmentSchema,
  spec: AkashTxSpecSchema,
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

export type AkashTxObserveInput = z.infer<typeof AkashTxObserveInputSchema>;
export type AkashTxCreateInput = z.infer<typeof AkashTxCreateInputSchema>;
export type AkashTxUpdateInput = z.infer<typeof AkashTxUpdateInputSchema>;
export type AkashTxDeleteInput = z.infer<typeof AkashTxDeleteInputSchema>;
