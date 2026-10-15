// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Immutable CI artifacts, independent of pull-request discovery. */
export interface BuildReleaseArtifact {
  readonly id: number;
  readonly digest: string;
  readonly name: string;
  readonly runId: number;
  readonly repository: string;
  readonly headRepository: string;
  readonly sourceSha: string;
  readonly workflowPath: string;
  readonly event: string;
  readonly headBranch: string;
  readonly payload: unknown;
}

export interface BuildReleasePort {
  /** Only completed successful producers; verify archive integrity before returning payloads. */
  readArtifacts(input: {
    readonly repository: string;
    readonly sourceSha: string;
  }): Promise<readonly BuildReleaseArtifact[]>;
}
