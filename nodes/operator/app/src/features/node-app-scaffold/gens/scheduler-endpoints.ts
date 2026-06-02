// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/node-app-scaffold/gens/scheduler-endpoints`
 * Purpose: Pure port of `scripts/ci/render-scheduler-worker-endpoints.sh`'s per-node insert, so
 *   the operator can author a node-birth PR's `scheduler-worker/configmap.yaml` edit without a
 *   repo checkout or running bash + yq.
 * Scope: Given the CURRENT committed `infra/k8s/base/scheduler-worker/configmap.yaml` and a new
 *   node's slug + node_id (uuid), return the new configmap byte-identical to what
 *   `pnpm gen:scheduler-worker-endpoints` produces once that node joins the catalog with that
 *   node_id in its repo-spec.
 * Invariants: CATALOG_IS_SSOT + REPO_SPEC_IS_IDENTITY_SSOT — the rendered CSV mirrors
 *   `node_internal_service_endpoint_csv` exactly: per node, a `<slug>=<url>` entry immediately
 *   followed by a `<node_id>=<url>` alias, ordered by NODE_TARGETS (catalog `*.yaml` glob ==
 *   slug-lexicographic). The new node is spliced into that order; the YAML line keeps the
 *   committed 2-space indent + double-quoted value.
 * Side-effects: none — pure string transform, no IO, no env.
 * Links: scripts/ci/render-scheduler-worker-endpoints.sh, scripts/ci/lib/image-tags.sh, task.5092
 * @public
 */

const ENDPOINTS_KEY = "COGNI_NODE_ENDPOINTS";
/** Mirrors the committed `data:` indent (2 spaces) + double-quoted value. */
const LINE_RE = new RegExp(`^(\\s*)${ENDPOINTS_KEY}:\\s*"([^"]*)"\\s*$`, "m");

/** `http://<slug>-node-app:3000` — the in-cluster Service DNS used for both the slug + uuid alias. */
function urlForSlug(slug: string): string {
  return `http://${slug}-node-app:3000`;
}

/** Per `node_internal_service_endpoint_csv`: `<slug>=<url>,<node_id>=<url>`. */
function entryPair(slug: string, nodeId: string): string {
  const url = urlForSlug(slug);
  return `${slug}=${url},${nodeId}=${url}`;
}

/**
 * Insert a new node's `<slug>=…` + `<node_id>=…` aliases into the scheduler-worker configmap's
 * `COGNI_NODE_ENDPOINTS` CSV, byte-identical to `pnpm gen:scheduler-worker-endpoints` after the
 * node joins the catalog.
 *
 * NODE_TARGETS is the catalog `*.yaml` glob == slug-lexicographic, so the new pair is spliced
 * before the first existing node whose slug sorts strictly after `slug` (shell `sort` == JS `>`),
 * else appended last. The pair's leading slug entry anchors the position; its uuid alias trails it.
 */
export function insertSchedulerEndpoint(
  currentConfigmap: string,
  slug: string,
  nodeId: string
): string {
  const match = LINE_RE.exec(currentConfigmap);
  if (!match) {
    throw new Error(`configmap is missing a quoted ${ENDPOINTS_KEY} line`);
  }
  const [line, indent, csv] = match;
  if (line === undefined || indent === undefined || csv === undefined) {
    throw new Error(
      `configmap ${ENDPOINTS_KEY} line did not capture its parts`
    );
  }

  // Split into per-node pairs: each pair is `<slug>=<url>,<node_id>=<url>` (two CSV cells).
  const cells = csv.length === 0 ? [] : csv.split(",");
  if (cells.length % 2 !== 0) {
    throw new Error(`${ENDPOINTS_KEY} CSV has an unpaired cell count`);
  }
  const pairs: { slug: string; text: string }[] = [];
  for (let i = 0; i < cells.length; i += 2) {
    const slugCell = cells[i];
    const aliasCell = cells[i + 1];
    if (slugCell === undefined || aliasCell === undefined) {
      throw new Error(`${ENDPOINTS_KEY} CSV has an unpaired cell count`);
    }
    const eq = slugCell.indexOf("=");
    pairs.push({
      slug: slugCell.slice(0, eq),
      text: `${slugCell},${aliasCell}`,
    });
  }

  if (pairs.some((p) => p.slug === slug)) {
    throw new Error(`${ENDPOINTS_KEY} already contains node '${slug}'`);
  }

  const newPair = { slug, text: entryPair(slug, nodeId) };
  const successor = pairs.findIndex((p) => p.slug > slug);
  if (successor === -1) {
    pairs.push(newPair);
  } else {
    pairs.splice(successor, 0, newPair);
  }

  const csvOut = pairs.map((p) => p.text).join(",");
  const lineOut = `${indent}${ENDPOINTS_KEY}: "${csvOut}"`;
  return currentConfigmap.replace(line, lineOut);
}
