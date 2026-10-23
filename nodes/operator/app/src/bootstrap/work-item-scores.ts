// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/work-item-scores`
 * Purpose: The operator's ONE evidence-host allow-list for work-item `scores`
 *   (story.5111), passed by the container to the Doltgres work-item adapter.
 * Scope: Configuration only. The bounds themselves live in
 *   `parseWorkItemScores` (`@cogni/work-items` 0.2.3).
 * Invariants:
 *   - SCORES_ONE_ENFORCER: the adapter is the only `scores` validator on the
 *     HTTP write path; the route contract checks shape only, so no second copy
 *     of this list exists. A rejection surfaces as HTTP 400 via the facade.
 *   - EXACT_HOSTS_ONLY: the package default plus the exact operator Grafana
 *     stack host (from `GRAFANA_URL`, when configured); never a shared-tenant
 *     wildcard such as `*.grafana.net`.
 * Side-effects: none
 * Links: cogni-dao/node-template#198 app/src/bootstrap/work-item-scores.ts,
 *   hub work-item-scores-design
 * @public
 */

import { DEFAULT_SCORE_EVIDENCE_HOSTS } from "@cogni/work-items";

/** Package default plus the exact host of `grafanaUrl`, when one is configured. */
export function workItemScoreEvidenceHosts(
  grafanaUrl: string | undefined
): readonly string[] {
  const hosts = new Set<string>(DEFAULT_SCORE_EVIDENCE_HOSTS);
  if (grafanaUrl) {
    try {
      const host = new URL(grafanaUrl).hostname.toLowerCase();
      if (host) hosts.add(host);
    } catch {
      // serverEnv already validates GRAFANA_URL as a URL; an unparsable value
      // simply adds no host (the default list stays in force).
    }
  }
  return Object.freeze([...hosts]);
}
