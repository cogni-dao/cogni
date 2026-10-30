// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Operator-local read protocol; no provider handles, selectors or secret values. */
export interface ComputeReleaseProofInput {
  readonly version: 1;
  readonly nonce: string;
  readonly expected: {
    readonly nodeId: string;
    readonly repository: string;
    readonly environment: "candidate-a" | "preview" | "production";
    readonly sourceSha: string;
    readonly deploySha: string;
    readonly bundleRef: string;
    readonly workloads: readonly {
      readonly instance: string | null;
      readonly kind: "XComputeWorkload" | "ComputeWorkload" | "Deployment";
      readonly publicHost: string | null;
      readonly leaseGeneration: number;
      readonly artifacts: readonly {
        readonly name: string;
        readonly image: string;
      }[];
      readonly services: readonly {
        readonly name: string;
        readonly artifact: string;
        readonly runtimeProfile: "cogni-node-app-v1" | "image-default";
        readonly commandTemplate:
          | "image-default"
          | "cogni-node-app-v1+database-ca-v1";
        readonly secretRefs: readonly { readonly key: string }[];
        readonly bindings: readonly {
          readonly key: string;
          readonly service: string;
        }[];
        readonly port: number;
        readonly visibility: "public" | "private";
        readonly bindHost: "0.0.0.0";
        readonly cpuUnits: number;
        readonly memoryMi: number;
        readonly storageMi: number;
      }[];
    }[];
  };
}
export type ProofVerdict = "verified" | "running" | "failed" | "unavailable";
export interface ComputeReleaseProofOutput {
  readonly version: 1;
  readonly hash: string;
  readonly nonce: string;
  readonly tuple: Omit<ComputeReleaseProofInput["expected"], "workloads">;
  readonly observedAt: string;
  readonly dimensions: readonly {
    readonly workload: string;
    readonly native: ProofVerdict;
    readonly migration: ProofVerdict;
    readonly provider: ProofVerdict;
    readonly code:
      | "verified"
      | "absent"
      | "ownership"
      | "wrong_source"
      | "stale_bundle"
      | "actuator_lag"
      | "unsupported_command"
      | "migration_running"
      | "migration_failed"
      | "migration_unavailable"
      | "provider_unavailable"
      | "unavailable";
  }[];
}
