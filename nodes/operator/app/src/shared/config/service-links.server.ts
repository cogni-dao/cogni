// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/config/service-links.server`
 * Purpose: The nodes the operator's git-review may call with signed per-call assertions
 *   (`.cogni/service-links.yaml`, keyed by deploy environment; task.5448).
 * Scope: Pure parse (`parseServiceLinks`) plus a cached file read. Reads no network and holds no key.
 * Invariants:
 *   - TARGETS_COME_FROM_GIT: the list is the Git file, never request input, an env var or the model.
 *   - ONE_READER: the review route, `decideCodeSubject` and the node-code capability all read through
 *     `getServiceLinkTargets` / `findServiceLinkTarget`, so they cannot disagree about what is listed.
 *   - MISSING_MEANS_NONE: a missing file, a missing environment section or an unparseable file is an
 *     empty list (fail closed). `parseLinkTargets` drops bad entries silently, so the tests count them.
 * Side-effects: IO (reads `.cogni/service-links.yaml` once)
 * Links: nodes/operator/.cogni/service-links.yaml, https://cognidao.org/knowledge/operator-identity-model
 * @public
 */

import fs from "node:fs";
import path from "node:path";
import {
  type LinkTarget,
  parseLinkTargets,
} from "@cogni-dao/agent-grants/service-auth";
import { parse as parseYaml } from "yaml";
import { serverEnv } from "@/shared/env";

export type { LinkTarget };

/** Targets of one deploy environment from the parsed file. Missing section or bad shape is `[]`. */
export function parseServiceLinks(
  doc: unknown,
  environment: string | undefined
): LinkTarget[] {
  if (!environment || !doc || typeof doc !== "object" || Array.isArray(doc))
    return [];
  const section = (doc as Record<string, unknown>)[environment];
  if (!section || typeof section !== "object" || Array.isArray(section))
    return [];
  return parseLinkTargets((section as { targets?: unknown }).targets);
}

let cached: { readonly doc: unknown } | undefined;

function loadServiceLinksDoc(): unknown {
  if (cached) return cached.doc;
  let doc: unknown;
  const repoRoot = serverEnv().COGNI_REPO_ROOT;
  if (repoRoot) {
    try {
      doc = parseYaml(
        fs.readFileSync(path.join(repoRoot, ".cogni", "service-links.yaml"), {
          encoding: "utf8",
        })
      );
    } catch {
      doc = undefined; // missing or unreadable: no targets
    }
  }
  cached = { doc };
  return doc;
}

/** The link targets of THIS operator's deploy environment. */
export function getServiceLinkTargets(): readonly LinkTarget[] {
  try {
    return parseServiceLinks(
      loadServiceLinksDoc(),
      serverEnv().DEPLOY_ENVIRONMENT
    );
  } catch {
    return []; // an unreadable server env lists nothing (fail closed); nothing is cached
  }
}

/** The listed target for a node id, or undefined when that node is not listed. */
export function findServiceLinkTarget(nodeId: string): LinkTarget | undefined {
  return getServiceLinkTargets().find((t) => t.nodeId === nodeId);
}

/** Test seam: forget the cached file. */
export function resetServiceLinksCache(): void {
  cached = undefined;
}
