// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/knowledge.domains.v1.contract`
 * Purpose: HTTP contract for the knowledge domain registry — GET list with entry counts and POST register (cookie-session only).
 * Scope: Zod schemas for the wire format. Does not contain business logic, I/O, or auth policy.
 * Invariants:
 *   - DOMAIN_HTTP_AUTH_SPLIT (route enforces; contract does not): GET requires
 *     a session cookie, while POST accepts a session or node bearer.
 *   - DOMAIN_REGISTRATION_IS_STICKY: no DELETE/PUT in v0.
 *   - id is short, slug-shaped (alnum, dash, underscore).
 * Side-effects: none
 * Links: docs/spec/knowledge-domain-registry.md
 * @internal
 */

import { z } from "zod";

const DomainIdSchema = z
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
