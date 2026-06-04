// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/gitmodules`
 * Purpose: Pure renderer for the operator monorepo's root `.gitmodules` when a new node is born as a
 *   git submodule (the submodule-birth path, vNext of `scaffold-node.sh`'s inline rsync). Lets the
 *   operator author the submodule-pin PR via the GitHub Git Data API without a checkout.
 * Scope: Given the current `.gitmodules` (or `null` when none exists yet), append a `[submodule
 *   "nodes/<slug>"]` stanza pinning the node repo at `nodes/<slug>`. Idempotent — re-rendering an
 *   already-present slug is a no-op.
 * Invariants: SUBMODULE_GITLINK_IS_OPERATOR_PIN (spec: node-ci-cd-contract) — the stanza + its gitlink
 *   tree entry classify operator-domain. One stanza per node; `path` always `nodes/<slug>`.
 * Side-effects: none — pure string transform, no IO, no env.
 * Links: docs/spec/node-ci-cd-contract.md §Submodule-pinned nodes, task.5009
 * @public
 */

/**
 * Append a submodule stanza for `nodes/<slug>` to the root `.gitmodules`. `current` is the existing
 * file content, or `null`/empty when the operator repo has no submodules yet. `url` is the minted
 * node repo's clone URL. Idempotent: if a stanza for this slug already exists, `current` is returned
 * unchanged.
 */
export function renderGitmodules(
  current: string | null,
  slug: string,
  url: string
): string {
  const header = `[submodule "nodes/${slug}"]`;
  const stanza = `${header}\n\tpath = nodes/${slug}\n\turl = ${url}\n`;
  const base = (current ?? "").trimEnd();
  if (base.includes(header)) return current ?? "";
  return base.length ? `${base}\n${stanza}` : stanza;
}
