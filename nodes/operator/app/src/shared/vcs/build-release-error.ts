// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Credential-free failure primitive for CI release policy and its artifact carrier. */
export class BuildReleaseError extends Error {
  constructor(
    readonly code:
      | "release_missing"
      | "release_invalid"
      | "release_provenance"
      | "release_conflict"
      | "release_integrity"
      | "release_unavailable",
    message: string
  ) {
    super(message);
    this.name = "BuildReleaseError";
  }
}
