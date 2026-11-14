// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ingestion-core/vcs-token-provider`
 * Purpose: Port interface for VCS token acquisition — abstracts PAT vs GitHub App vs future auth methods.
 * Scope: Pure interface. Does not contain implementations — those live in services/scheduler-worker/.
 * Invariants:
 * - ADAPTERS_NOT_IN_CORE: Only types here. No I/O, no deps.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger, services/scheduler-worker/src/adapters/ingestion/github-auth.ts
 * @public
 */

export interface VcsTokenResult {
  readonly token: string;
  readonly expiresAt?: Date;
}

export interface VcsTokenProvider {
  getToken(params: {
    /** VCS platform: "github" | "gitlab" */
    provider: string;
    /** Requested capability: "ingest" | "review" | "admin" */
    capability: string;
    /** Optional repo ref for scoped tokens: "owner/repo" */
    repoRef?: string;
  }): Promise<VcsTokenResult>;
}
