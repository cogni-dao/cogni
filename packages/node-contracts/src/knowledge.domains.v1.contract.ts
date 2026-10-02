// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/knowledge.domains.v1.contract`
 * Purpose: HTTP contract for the knowledge domain registry — list, register, and guarded deletion for authenticated principals.
 * Scope: Zod schemas for the wire format. Does not contain business logic, I/O, or auth policy.
 * Invariants:
 *   - DOMAIN_AUTHENTICATED_CONTROL_PLANE: Bearer agents and session users share the same contract.
 *   - DOMAIN_DELETE_EMPTY_ONLY: deletion conflicts while entries or citation references remain.
 *   - id is short, slug-shaped (alnum, dash, underscore).
 * Side-effects: none
 * Links: docs/spec/knowledge-domain-registry.md
 * @internal
 */

import { z } from "zod";

export const DomainIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, {
    message: "domain id must start with [a-z0-9] and contain only [a-z0-9_-]",
  });

export const DomainSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  confidencePct: z.number().int(),
  entryCount: z.number().int(),
  createdAt: z.string(),
});
export type DomainRow = z.infer<typeof DomainSchema>;

export const DomainsListResponseSchema = z.object({
  domains: z.array(DomainSchema),
});
export type DomainsListResponse = z.infer<typeof DomainsListResponseSchema>;

export const DomainsCreateRequestSchema = z.object({
  id: DomainIdSchema,
  name: z.string().min(1).max(128),
  description: z.string().max(512).optional(),
});
export type DomainsCreateRequest = z.infer<typeof DomainsCreateRequestSchema>;

export const DomainsCreateResponseSchema = DomainSchema;
export type DomainsCreateResponse = z.infer<typeof DomainsCreateResponseSchema>;

export const DomainsDeleteRequestSchema = z.object({
  id: DomainIdSchema,
});
export type DomainsDeleteRequest = z.infer<typeof DomainsDeleteRequestSchema>;

export const DomainsDeleteResponseSchema = z.object({
  id: DomainIdSchema,
  deleted: z.literal(true),
});
export type DomainsDeleteResponse = z.infer<typeof DomainsDeleteResponseSchema>;

export const DomainsDeleteConflictResponseSchema = z.object({
  error: z.literal("domain_in_use"),
  domain: DomainIdSchema,
  entryCount: z.number().int().nonnegative(),
  referenceCount: z.number().int().nonnegative(),
});
export type DomainsDeleteConflictResponse = z.infer<
  typeof DomainsDeleteConflictResponseSchema
>;

export const DomainsErrorResponseSchema = z.object({
  error: z.string(),
});

export const knowledgeDomainsListOperation = {
  id: "knowledge.domains.list.v1",
  summary: "List registered knowledge domains",
  description:
    "Returns the node-local domain registry with entry counts. Accepts a Bearer API key or an authenticated session cookie.",
  input: z.object({}),
  output: DomainsListResponseSchema,
} as const;

export const knowledgeDomainsCreateOperation = {
  id: "knowledge.domains.create.v1",
  summary: "Register a knowledge domain",
  description:
    "Registers a node-local knowledge domain and creates a Dolt commit. Accepts a Bearer API key or an authenticated session cookie.",
  input: DomainsCreateRequestSchema,
  output: DomainsCreateResponseSchema,
} as const;

export const knowledgeDomainsDeleteOperation = {
  id: "knowledge.domains.delete.v1",
  summary: "Delete an empty knowledge domain",
  description:
    "Deletes a node-local domain only when no knowledge entries or citation references remain, then creates a Dolt commit. Returns a typed 409 conflict otherwise.",
  input: DomainsDeleteRequestSchema,
  output: DomainsDeleteResponseSchema,
  conflict: DomainsDeleteConflictResponseSchema,
} as const;
