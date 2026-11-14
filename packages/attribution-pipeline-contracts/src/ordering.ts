// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-contracts/ordering`
 * Purpose: Enricher dependency DAG validation — cycle detection, missing ref detection, topological order verification.
 * Scope: Pure functions. Does not perform I/O or hold state.
 * Invariants:
 * - ENRICHER_ORDER_EXPLICIT: declared order must be a valid topological sort of the dependency graph.
 * - FRAMEWORK_NO_IO: this module contains zero I/O.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-plugin-pipeline
 * @public
 */

import type { EnricherRef } from "./profile";

/**
 * Validate that the enricher refs form a valid dependency DAG and that
 * the declared order is a valid topological sort.
 *
 * Throws on:
 * - Missing refs: a dependsOnEvaluations entry references an enricherRef not in the list
 * - Cycles: the dependency graph contains a cycle
 * - Invalid order: the declared order violates the dependency graph (a dep appears after its dependent)
 */
export function validateEnricherOrder(
  enricherRefs: readonly EnricherRef[]
): void {
  const refSet = new Set(enricherRefs.map((r) => r.enricherRef));

  // 1. Check for missing refs
  for (const ref of enricherRefs) {
    for (const dep of ref.dependsOnEvaluations) {
      if (!refSet.has(dep)) {
        throw new Error(
          `Enricher "${ref.enricherRef}" depends on "${dep}" which is not in the effective enricher refs`
        );
      }
    }
  }

  // 2. Check for cycles via DFS
  const UNVISITED = 0;
  const IN_PROGRESS = 1;
  const DONE = 2;

  const state = new Map<string, number>();
  for (const ref of enricherRefs) {
    state.set(ref.enricherRef, UNVISITED);
  }

  // Build adjacency list (enricherRef → dependsOnEvaluations[])
  const deps = new Map<string, readonly string[]>();
  for (const ref of enricherRefs) {
    deps.set(ref.enricherRef, ref.dependsOnEvaluations);
  }

  function visit(node: string, path: string[]): void {
    const s = state.get(node);
    if (s === DONE) return;
    if (s === IN_PROGRESS) {
      const cycleStart = path.indexOf(node);
      const cycle = [...path.slice(cycleStart), node].join(" → ");
      throw new Error(`Cycle detected in enricher dependencies: ${cycle}`);
    }

    state.set(node, IN_PROGRESS);
    const nodeDeps = deps.get(node) ?? [];
    for (const dep of nodeDeps) {
      visit(dep, [...path, node]);
    }
    state.set(node, DONE);
  }

  for (const ref of enricherRefs) {
    visit(ref.enricherRef, []);
  }

  // 3. Check that declared order respects dependencies
  // Each enricher's dependencies must appear before it in the array
  const positionOf = new Map<string, number>();
  for (let i = 0; i < enricherRefs.length; i++) {
    const ref = enricherRefs[i];
    if (ref) {
      positionOf.set(ref.enricherRef, i);
    }
  }

  for (const ref of enricherRefs) {
    const refPos = positionOf.get(ref.enricherRef);
    if (refPos === undefined) continue;

    for (const dep of ref.dependsOnEvaluations) {
      const depPos = positionOf.get(dep);
      if (depPos === undefined) continue; // already caught by missing ref check

      if (depPos >= refPos) {
        throw new Error(
          `Enricher "${ref.enricherRef}" depends on "${dep}" but "${dep}" appears after it in the declared order (position ${depPos} >= ${refPos})`
        );
      }
    }
  }
}
