// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/knowledge-remote`
 * Purpose: Derive Cogni-owned DoltHub mirror identity for a newly birthed node.
 * Scope: Pure naming only. Credentials and repo creation stay out of repo-spec.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/dolthub-mirror-bootstrap, packages/repo-spec/src/schema.ts
 * @public
 */

export interface NodeKnowledgeRemote {
  readonly database: string;
  readonly owner: string;
  readonly repo: string;
  readonly url: string;
}

export function knowledgeDatabaseForSlug(slug: string): string {
  return `knowledge_${slug.replaceAll("-", "_")}`;
}

export function knowledgeRepoForSlug(slug: string): string {
  // DoltHub repo name mirrors the node slug 1:1 (dolt name == git name). The
  // operator node is the current mismatch (its git repo is `cogni`, slug is
  // `operator`) — that is tolerated; the git repo rename is future work. No
  // `knowledge-` prefix and no per-node exceptions — the retired prefix is now
  // rejected by knowledgeRemoteSpecSchema, not merely dropped here.
  //
  // The local Doltgres DATABASE keeps its `knowledge_<slug>` prefix
  // (knowledgeDatabaseForSlug) on purpose: that is the node's live internal DB
  // identity, distinct from the mirror repo name. The mirror is push-only, so
  // nothing clones back expecting the two to match.
  return slug;
}

export function knowledgeRepoWebUrl(input: {
  readonly owner: string;
  readonly slug: string;
}): string {
  return `https://www.dolthub.com/repositories/${input.owner}/${knowledgeRepoForSlug(input.slug)}`;
}

export function knowledgeRemoteWebUrl(remote: NodeKnowledgeRemote): string {
  return `https://www.dolthub.com/repositories/${remote.owner}/${remote.repo}`;
}

export function buildNodeKnowledgeRemote(
  slug: string,
  owner: string
): NodeKnowledgeRemote {
  const repo = knowledgeRepoForSlug(slug);
  return {
    database: knowledgeDatabaseForSlug(slug),
    owner,
    repo,
    url: `https://doltremoteapi.dolthub.com/${owner}/${repo}`,
  };
}
