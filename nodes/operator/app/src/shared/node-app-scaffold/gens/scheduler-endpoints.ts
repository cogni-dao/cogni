// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/scheduler-endpoints`
 * Purpose: Pure port of `scripts/ci/render-scheduler-worker-endpoints.sh`'s per-node edits, so
 *   the operator can author a node-formation OR node-placement PR's scheduler-worker routing
 *   edits without a repo checkout or running bash + yq.
 * Scope: Given ANY currently-committed ConfigMap document carrying a quoted `COGNI_NODE_ENDPOINTS`
 *   line — the shared base `infra/k8s/base/scheduler-worker/configmap.yaml` AND each deploy env's
 *   generated `infra/k8s/overlays/<env>/scheduler-worker/node-endpoints.patch.yaml` (bug.5094) —
 *   membership edits keep workload and custodied namespace maps consistent; placement/birth edits:
 *     - `insertSchedulerEndpoint` splices a NEW node's slug + node_id (uuid) aliases in, byte-
 *       identical to what `pnpm gen:scheduler-worker-endpoints` produces once that node joins the
 *       catalog. A birth is always k3s (`deployment_provider` absent → K3S_IS_DEFAULT), so the
 *       in-cluster URL is the correct insert for every one of them.
 *     - `updateSchedulerEndpointHost` rewrites an EXISTING node's routed URL (story.5016 T5's
 *       placement lever) — a flip between the in-cluster Service DNS and the node's public host
 *       changes WHERE the pair points, not whether the pair exists.
 * Invariants: CATALOG_IS_SSOT + REPO_SPEC_IS_IDENTITY_SSOT — the rendered CSV mirrors
 *   `node_internal_service_endpoint_csv` exactly: per node, a `<slug>=<url>` entry immediately
 *   followed by a `<node_id>=<url>` alias, ordered by NODE_TARGETS (catalog `*.yaml` glob ==
 *   slug-lexicographic). `insertSchedulerEndpoint` splices a new pair into that order;
 *   `updateSchedulerEndpointHost` rewrites an existing pair in place, order untouched. Both keep
 *   the committed 2-space indent + double-quoted value.
 * Side-effects: none — pure string transforms, no IO, no env.
 * Links: scripts/ci/render-scheduler-worker-endpoints.sh, scripts/ci/lib/image-tags.sh, task.5092,
 *   src/shared/node-app-scaffold/gens/env-membership-plan.ts (buildPlacementPlan, the placement caller)
 * @public
 */

const ENDPOINTS_KEY = "COGNI_NODE_ENDPOINTS";
const CUSTODY_KEY = "TEMPORAL_CUSTODIED_NODE_ENDPOINTS";

/** Change one paired membership, retaining sibling bytes and canonical pair order. */
function membershipCsv(
  csv: string,
  slug: string,
  nodeId: string,
  url: string | null
): string {
  const cells = csv ? csv.split(",") : [];
  if (cells.length % 2) throw new Error("unpaired scheduler aliases");
  const pairs: { slug: string; id: string; text: string }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < cells.length; i += 2) {
    const first = /^([a-z][a-z0-9-]*)=(https?:\/\/[^,]+)$/.exec(cells[i] ?? "");
    const second =
      /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})=(https?:\/\/[^,]+)$/.exec(
        cells[i + 1] ?? ""
      );
    if (
      !first ||
      !second ||
      first[2] !== second[2] ||
      seen.has(first[1] ?? "") ||
      seen.has(second[1] ?? "")
    )
      throw new Error("invalid or duplicate scheduler alias pair");
    if (
      !first[1] ||
      !second[1] ||
      !first[2] ||
      new URL(first[2]).origin !== first[2]
    )
      throw new Error("invalid scheduler endpoint origin");
    seen.add(first[1]);
    seen.add(second[1]);
    pairs.push({
      slug: first[1],
      id: second[1],
      text: `${cells[i]},${cells[i + 1]}`,
    });
  }
  const found = pairs.find((pair) => pair.slug === slug);
  if (
    (found && found.id !== nodeId) ||
    pairs.some((pair) => pair.id === nodeId && pair.slug !== slug)
  )
    throw new Error("scheduler node identity mismatch");
  const next = pairs.filter((pair) => pair.slug !== slug);
  if (url !== null) {
    const pair = { slug, id: nodeId, text: `${slug}=${url},${nodeId}=${url}` };
    const index = next.findIndex((entry) => entry.slug > slug);
    next.splice(index === -1 ? next.length : index, 0, pair);
  }
  return next.map((pair) => pair.text).join(",");
}

/** Env membership follows the renderer: absent nodes have no workload-lane aliases. */
export function setSchedulerEndpointMembership(
  text: string,
  slug: string,
  nodeId: string,
  url: string | null
): string {
  const matches = [...text.matchAll(new RegExp(LINE_RE.source, "gm"))];
  const match = matches[0];
  if (
    matches.length !== 1 ||
    !match ||
    match[1] === undefined ||
    match[2] === undefined
  )
    throw new Error(`expected one quoted ${ENDPOINTS_KEY} line`);
  return text.replace(
    match[0],
    `${match[1]}${ENDPOINTS_KEY}: "${membershipCsv(match[2], slug, nodeId, url)}"`
  );
}

/** Update only one lane/node in its derived control worker's canonical JSON map. */
export function setCustodiedSchedulerEndpointMembership(
  text: string,
  lane: string,
  slug: string,
  nodeId: string,
  url: string | null
): string {
  const matches = [
    ...text.matchAll(/^ {2}TEMPORAL_CUSTODIED_NODE_ENDPOINTS: (.*)$/gm),
  ];
  const match = matches[0];
  if (matches.length !== 1 || !match || match[1] === undefined)
    throw new Error(`expected one quoted ${CUSTODY_KEY} line`);
  const scalar = match[1];
  if (!(scalar === '"{}"' || /^'(?:[^']|'')*'$/.test(scalar)))
    throw new Error("noncanonical custody scalar");
  const raw =
    scalar === '"{}"' ? "{}" : scalar.slice(1, -1).replaceAll("''", "'");
  const parsed: unknown = JSON.parse(raw);
  if (
    !parsed ||
    Array.isArray(parsed) ||
    typeof parsed !== "object" ||
    JSON.stringify(parsed) !== raw
  )
    throw new Error("noncanonical custody map");
  const map = parsed as Record<string, unknown>;
  const keys = Object.keys(map);
  if (keys.join(",") !== [...keys].sort().join(","))
    throw new Error("noncanonical custody namespace order");
  for (const [key, value] of Object.entries(map)) {
    if (!/^cogni-[a-z][a-z0-9-]*$/.test(key) || typeof value !== "string")
      throw new Error("invalid custody namespace");
    // Validate existing sibling maps without changing their representation.
    membershipCsv(value, slug, nodeId, null);
  }
  const namespace = `cogni-${lane}`;
  const next = membershipCsv(
    (map[namespace] as string | undefined) ?? "",
    slug,
    nodeId,
    url
  );
  if (next) map[namespace] = next;
  else delete map[namespace];
  const result = JSON.stringify(
    Object.fromEntries(
      Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    )
  );
  const quoted = result === "{}" ? '"{}"' : `'${result.replaceAll("'", "''")}'`;
  return text.replace(match[0], `  ${CUSTODY_KEY}: ${quoted}`);
}
/**
 * Mirrors the committed `data:` indent (2 spaces) + double-quoted value. The trailing class is
 * `[^\S\r\n]*` (horizontal whitespace only), NOT `\s*` — bug.5073's exact failure mode: `\s`
 * includes `\n`, and every generated per-env `node-endpoints.patch.yaml` has this line as its
 * LAST line before EOF, so a greedy `\s*$` swallows the file's final newline into the match. A
 * plain string `.replace(line, lineOut)` then emits `lineOut` (no trailing newline) in its place,
 * silently stripping the file's terminator on every edit. Matching only horizontal whitespace
 * leaves the trailing `\n` outside the match, exactly like `ENVS_LINE_RE` (env-membership.ts).
 */
const LINE_RE = new RegExp(
  `^(\\s*)${ENDPOINTS_KEY}:[^\\S\\r\\n]*"([^"]*)"[^\\S\\r\\n]*$`,
  "m"
);

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

/**
 * Rewrite an EXISTING node's routed URL in the scheduler-worker configmap's `COGNI_NODE_ENDPOINTS`
 * CSV — both its `<slug>=` cell and its `<node_id>=` alias cell — to `newUrl`, preserving position.
 * The placement lever (story.5016 T5) flips WHERE a node's app is dialed, not WHETHER it is routed:
 * an insert would reject it as a duplicate, and an append would dislodge slug-lexicographic order
 * for no reason. `nodeId` is asserted against the existing alias cell so a caller passing a
 * stale/foreign UUID fails loud instead of silently rewriting under the wrong identity.
 * An env ADD may explicitly insert a missing pair after canonical rendering removed it.
 * Placement and remove callers retain the strict existing-pair default.
 */
export function updateSchedulerEndpointHost(
  currentConfigmap: string,
  slug: string,
  nodeId: string,
  newUrl: string,
  options: { readonly insertIfMissing?: boolean } = {}
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

  const cells = csv.length === 0 ? [] : csv.split(",");
  if (cells.length % 2 !== 0) {
    throw new Error(`${ENDPOINTS_KEY} CSV has an unpaired cell count`);
  }

  let found = false;
  const outCells: string[] = [];
  for (let i = 0; i < cells.length; i += 2) {
    const slugCell = cells[i];
    const aliasCell = cells[i + 1];
    if (slugCell === undefined || aliasCell === undefined) {
      throw new Error(`${ENDPOINTS_KEY} CSV has an unpaired cell count`);
    }
    const cellSlug = slugCell.slice(0, slugCell.indexOf("="));
    const cellAlias = aliasCell.slice(0, aliasCell.indexOf("="));
    if (cellSlug === slug) {
      found = true;
      if (cellAlias !== nodeId) {
        throw new Error(
          `${ENDPOINTS_KEY} entry for '${slug}' has node_id '${cellAlias}', expected '${nodeId}'`
        );
      }
      outCells.push(`${slug}=${newUrl}`, `${nodeId}=${newUrl}`);
    } else {
      outCells.push(slugCell, aliasCell);
    }
  }
  if (!found) {
    if (options.insertIfMissing) {
      if (cells.some((cell) => cell.slice(0, cell.indexOf("=")) === nodeId)) {
        throw new Error(
          `${ENDPOINTS_KEY} already contains node_id '${nodeId}' under another node`
        );
      }
      return updateSchedulerEndpointHost(
        insertSchedulerEndpoint(currentConfigmap, slug, nodeId),
        slug,
        nodeId,
        newUrl
      );
    }
    throw new Error(`${ENDPOINTS_KEY} does not contain node '${slug}'`);
  }

  const csvOut = outCells.join(",");
  const lineOut = `${indent}${ENDPOINTS_KEY}: "${csvOut}"`;
  return currentConfigmap.replace(line, lineOut);
}
