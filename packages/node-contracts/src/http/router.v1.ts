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

import { metaLivezOutputSchema } from "../meta.livez.read.v1.contract";
import { metaReadyzOutputSchema } from "../meta.readyz.read.v1.contract";
import { metaRoutesOutputSchema } from "../meta.route-manifest.read.v1.contract";
import { workItemsCreateOperation } from "../work.items.create.v1.contract";
import { workItemsPatchOperation } from "../work.items.patch.v1.contract";

const c = initContract();

export const ApiContractV1 = c.router({
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
  workItemsCreate: {
    method: "POST",
    path: "/work/items",
    summary: workItemsCreateOperation.summary,
    description: workItemsCreateOperation.description,
    body: workItemsCreateOperation.input,
    responses: {
      201: workItemsCreateOperation.output,
    },
  },
  workItemsPatch: {
    method: "PATCH",
    path: "/work/items/:id",
    summary: workItemsPatchOperation.summary,
    description: workItemsPatchOperation.description,
    body: workItemsPatchOperation.input.omit({ id: true }),
    responses: {
      200: workItemsPatchOperation.output,
    },
  },
  // Future endpoints: metaOpenapi, etc.
});
