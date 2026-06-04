// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/showcase/getShowcaseNodes.server`
 * Purpose: Server accessor that wires the NodeRegistryPort (v0: static adapter + env base domain) and
 *   returns nodes for the homepage. The page depends on this accessor + the port's NodeSummary, not
 *   the underlying data source.
 * Scope: Server-only env wiring. Host-mapping logic lives in (pure) nodes.resolve.ts.
 * Side-effects: reads env (serverEnv) only.
 * Links: src/ports/node-registry.port.ts, src/features/home/showcase/static-node-registry.adapter.ts
 * @public
 */

import type { NodeRegistryPort, NodeSummary } from "@/ports/node-registry";
import { serverEnv } from "@/shared/env";

import { SHOWCASE_NODES } from "./nodes.data";
import { baseDomain } from "./nodes.resolve";
import { StaticNodeRegistryAdapter } from "./static-node-registry.adapter";

/** Build the v0 node registry (static adapter bound to the env base domain). */
export function nodeRegistry(): NodeRegistryPort {
  return new StaticNodeRegistryAdapter(SHOWCASE_NODES, baseDomain(serverEnv()));
}

/** Public showcase nodes for the homepage. */
export function listShowcaseNodes(): Promise<readonly NodeSummary[]> {
  return nodeRegistry().listPublic();
}
