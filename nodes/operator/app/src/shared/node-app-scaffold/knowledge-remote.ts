// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/knowledge-remote`
 * Purpose: Derive Cogni-owned DoltHub mirror identity for a newly birthed node.
 * Scope: Pure naming only. Credentials and repo creation stay out of repo-spec.
 * Side-effects: none
 * Links: docs/runbooks/dolthub-remote-bootstrap.md, packages/repo-spec/src/schema.ts
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
  return `knowledge-${slug}`;
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
