// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { ProvisionState } from "@cogni/ai-tools";

export interface ComputeWorkloadSource {
  readonly repository: string;
  readonly sha: string;
}

/** One immutable CI-produced OCI artifact. The digest has one authority: `image`. */
export interface ComputeWorkloadArtifact {
  readonly name: string;
  readonly image: string;
}

export interface ComputeWorkloadBundle {
  /** Immutable OCI reference for the atomic bundle manifest selected by CI. */
  readonly ref: string;
  readonly source: ComputeWorkloadSource;
  readonly artifacts: readonly ComputeWorkloadArtifact[];
}

/** A value-free reference into the node/env/service scoped secret resolver (task.5054). */
export interface ComputeWorkloadSecretRef {
  readonly key: string;
}

/** Git-safe runtime declaration. `env` is non-secret binding/config only. */
export interface DeclaredProvisionServiceSpec {
  readonly name: string;
  readonly artifact: string;
  readonly runtimeProfile?: "cogni-node-app-v1";
  readonly secretRefs?: readonly ComputeWorkloadSecretRef[];
  readonly command?: readonly string[];
  readonly args?: readonly string[];
  readonly port: number;
  readonly visibility: "public" | "private";
  readonly bindings: Readonly<Record<string, string>>;
  readonly bindHost: "0.0.0.0";
  readonly cpuUnits: number;
  readonly memoryMi: number;
  readonly storageMi: number;
}

export interface DeclaredProvisionSpec {
  readonly name: string;
  readonly publicHost: string;
  readonly services: readonly DeclaredProvisionServiceSpec[];
}

export interface ComputeWorkloadSpec {
  readonly nodeId: string;
  readonly environment: string;
  readonly bundle: ComputeWorkloadBundle;
  readonly workload: DeclaredProvisionSpec;
}
