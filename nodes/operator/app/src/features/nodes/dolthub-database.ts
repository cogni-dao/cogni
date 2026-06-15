// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/dolthub-database`
 * Purpose: Create Cogni-owned DoltHub databases for node knowledge mirrors.
 * Scope: Thin REST client around DoltHub's database create endpoint.
 * Side-effects: network IO when ensureDatabase is called.
 * Links: docs/runbooks/dolthub-remote-bootstrap.md
 * @internal
 */

const DOLTHUB_DATABASE_ENDPOINT =
  "https://www.dolthub.com/api/v1alpha1/database";

export interface EnsureDoltHubDatabaseInput {
  readonly owner: string;
  readonly repo: string;
  readonly description: string;
}

export interface EnsureDoltHubDatabaseResult {
  readonly owner: string;
  readonly repo: string;
  readonly created: boolean;
}

export interface DoltHubDatabaseEnsurer {
  ensureDatabase(
    input: EnsureDoltHubDatabaseInput
  ): Promise<EnsureDoltHubDatabaseResult>;
}

interface DoltHubResponseBody {
  readonly status?: unknown;
  readonly error?: unknown;
  readonly message?: unknown;
}

function bodyText(body: DoltHubResponseBody | string): string {
  if (typeof body === "string") return body;
  return [body.status, body.error, body.message]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
}

function isAlreadyExists(body: DoltHubResponseBody | string): boolean {
  return /already exists|database exists|duplicate/i.test(bodyText(body));
}

async function parseBody(response: Response): Promise<DoltHubResponseBody> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as DoltHubResponseBody;
  } catch {
    return { message: text };
  }
}

export function createDoltHubDatabaseEnsurer(env: {
  readonly DOLTHUB_API_TOKEN: string | undefined;
}): DoltHubDatabaseEnsurer {
  if (!env.DOLTHUB_API_TOKEN) {
    throw new Error("DOLTHUB_API_TOKEN required for node DoltHub bootstrap");
  }

  const token = env.DOLTHUB_API_TOKEN;

  return {
    async ensureDatabase(input) {
      const response = await fetch(DOLTHUB_DATABASE_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `token ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ownerName: input.owner,
          repoName: input.repo,
          description: input.description,
          visibility: "public",
        }),
      });
      const body = await parseBody(response);
      if (response.ok && !isAlreadyExists(body)) {
        return { owner: input.owner, repo: input.repo, created: true };
      }
      if (isAlreadyExists(body)) {
        return { owner: input.owner, repo: input.repo, created: false };
      }
      throw new Error(`DoltHub database create failed: ${bodyText(body)}`);
    },
  };
}
