// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/http/router.v1`
 * Purpose: ts-rest HTTP contract router for API v1 endpoints.
 * Scope: Defines HTTP-specific contracts. Does not include protocol-neutral operations.
 * Invariants: All routes map to protocol-neutral operations; HTTP methods and paths stable.
 * Side-effects: none
 * Notes: Used by OpenAPI generation and future ts-rest server adapters.
 * Links: Protocol-neutral operations, OpenAPI generator
 * @internal
 */

import { initContract } from "@ts-rest/core";

import {
  DomainsCreateRequestSchema,
  DomainsCreateResponseSchema,
  DomainsDeleteConflictResponseSchema,
  DomainsDeleteRequestSchema,
  DomainsDeleteResponseSchema,
  DomainsErrorResponseSchema,
  DomainsListResponseSchema,
} from "../knowledge.domains.v1.contract";
import { metaLivezOutputSchema } from "../meta.livez.read.v1.contract";
import { metaReadyzOutputSchema } from "../meta.readyz.read.v1.contract";
import { metaRoutesOutputSchema } from "../meta.route-manifest.read.v1.contract";

const c = initContract();

export const ApiContractV1 = c.router({
  knowledgeDomainsList: {
    method: "GET",
    path: "/knowledge/domains",
    summary: "List registered knowledge domains",
    description:
      "Returns the node-local domain registry for a Bearer API key or authenticated session cookie.",
    metadata: { auth: "bearer-or-session" },
    responses: {
      200: DomainsListResponseSchema,
      401: DomainsErrorResponseSchema,
      503: DomainsErrorResponseSchema,
    },
  },
  knowledgeDomainsCreate: {
    method: "POST",
    path: "/knowledge/domains",
    summary: "Register a knowledge domain",
    description:
      "Registers a node-local domain and auto-commits the write to Dolt. Accepts a Bearer API key or authenticated session cookie.",
    metadata: { auth: "bearer-or-session" },
    body: DomainsCreateRequestSchema,
    responses: {
      201: DomainsCreateResponseSchema,
      400: DomainsErrorResponseSchema,
      401: DomainsErrorResponseSchema,
      409: DomainsErrorResponseSchema,
      503: DomainsErrorResponseSchema,
    },
  },
  knowledgeDomainsDelete: {
    method: "DELETE",
    path: "/knowledge/domains/:id",
    pathParams: DomainsDeleteRequestSchema,
    summary: "Delete an empty knowledge domain",
    description:
      "Deletes and Dolt-commits a node-local domain only when no knowledge entries or citation references remain.",
    metadata: { auth: "bearer-or-session" },
    responses: {
      200: DomainsDeleteResponseSchema,
      400: DomainsErrorResponseSchema,
      401: DomainsErrorResponseSchema,
      404: DomainsErrorResponseSchema,
      409: DomainsDeleteConflictResponseSchema,
      503: DomainsErrorResponseSchema,
    },
  },
  metaRouteManifest: {
    method: "GET",
    path: "/meta/route-manifest",
    summary: "Route manifest for UI + e2e",
    description: "Lists public routes and tags for a11y and agents.",
    responses: {
      200: metaRoutesOutputSchema,
    },
  },
  metaLivez: {
    method: "GET",
    path: "/livez",
    summary: "Liveness probe - process alive",
    description:
      "Fast liveness check confirming the process is alive and can handle requests. No dependency checks. HTTP status: 200 = alive, 5xx = not alive.",
    responses: {
      200: metaLivezOutputSchema,
    },
  },
  metaReadyz: {
    method: "GET",
    path: "/readyz",
    summary: "Readiness probe - full validation",
    description:
      "Readiness check validating environment, secrets, and runtime requirements. Used for deployment gates and container orchestration. HTTP status: 200 = ready, 503 = not ready.",
    responses: {
      200: metaReadyzOutputSchema,
      503: metaReadyzOutputSchema,
    },
  },
  // Future endpoints: metaOpenapi, etc.
});
