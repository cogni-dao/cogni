// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/repo`
 * Purpose: Barrel exports for repository access adapters.
 * Scope: Re-exports RipgrepAdapter, GitLsFilesAdapter, and related types. Does not contain logic.
 * Invariants: All public adapter types exported via named exports.
 * Side-effects: none
 * Links: src/adapters/server/index.ts (re-exported from main server barrel)
 * @internal
 */

export {
  GitLsFilesAdapter,
  type GitLsFilesAdapterConfig,
} from "./git-ls-files.adapter";
export {
  RepoPathError,
  RipgrepAdapter,
  type RipgrepAdapterConfig,
} from "./ripgrep.adapter";
