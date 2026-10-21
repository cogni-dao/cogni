// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/preview-flight`
 * Purpose: Declare the opt-in trusted TEST build-preview control surface.
 * Scope: Types and injected IO only; does not hold provider credentials or deploy resources.
 * Invariants: One immutable request owns one paid attempt; unresolved cleanup retains capacity.
 * Side-effects: none
 * Links: features/compute/preview-flight, akash-preview-admission.port.ts
 * @public
 */

export interface PreviewFlightRequest {
  readonly nodeId: string;
  readonly slug: string;
  readonly sourceSha: string;
  readonly requestKey: string;
  readonly ttlSeconds?: number;
}
export interface PreviewFlightStatus {
  readonly deploymentId: string;
  readonly nodeId: string;
  readonly sourceSha: string;
  readonly url: string;
  readonly expiresAt: string;
  readonly state: "pending" | "running" | "retiring" | "closed";
}
export interface PreviewFlightPort {
  cancelRequest(input: PreviewFlightRequest): Promise<PreviewFlightStatus>;
  request(input: PreviewFlightRequest): Promise<PreviewFlightStatus>;
  status(input: {
    nodeId: string;
    deploymentId: string;
  }): Promise<PreviewFlightStatus>;
  release(input: {
    nodeId: string;
    deploymentId: string;
  }): Promise<PreviewFlightStatus>;
  sweep(): Promise<void>;
}
export interface PreviewSourceInput {
  readonly nodeId: string;
  readonly slug: string;
  readonly sourceSha: string;
}
/** Public, immutable source inputs; the existing App checks catalog and node identity. */
export interface PreviewSource {
  readonly repoSpecText: string;
  readonly catalogText: string;
  readonly sourceRepo: string;
  readonly imageRepository: string;
}
export interface PreviewSourcePort {
  read(input: PreviewSourceInput): Promise<PreviewSource>;
}
export interface NodeBundleReaderPort {
  read(input: {
    repository: string;
    sourceSha: string;
  }): Promise<{ bundleRef: string; payload: unknown }>;
}
export interface PreviewGitPort {
  publish(input: {
    deploymentId: string;
    files: readonly { path: string; content: string }[];
  }): Promise<void>;
  /** Always advances the branch with a non-force CAS, including an already absent path. */
  remove(deploymentId: string): Promise<void>;
  absent(deploymentId: string): Promise<boolean>;
}
export interface PreviewStatePairPort {
  /** Runs inside the durable admission row fence. Must not re-enter that ledger. */
  prepare(input: {
    deploymentId: string;
    stateSlot: 0 | 1;
  }): Promise<{ resetGeneration: string }>;
}
export interface PreviewCleanupObserverPort {
  /** Unreadable or remaining owned XR/DNS/Job/Pods returns false, never inferred absence. */
  absent(input: {
    deploymentId: string;
    nodeId: string;
    resetGeneration?: string;
    bundleRef: string;
  }): Promise<boolean>;
}
export class PreviewFlightError extends Error {
  constructor(
    readonly code:
      | "disabled"
      | "invalid_request"
      | "not_found"
      | "conflict"
      | "unavailable",
    message: string
  ) {
    super(message);
  }
}
