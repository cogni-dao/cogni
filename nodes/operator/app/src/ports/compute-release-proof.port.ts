// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Read-only capability. A caller abort never releases admission before original IO settles. */
import type { ComputeReleaseProofInput, ComputeReleaseProofOutput } from "@/types/compute-release-proof";
export interface ComputeReleaseProofPort {
 sample(input:ComputeReleaseProofInput, signal:AbortSignal):Promise<ComputeReleaseProofOutput>;
}

/** Internal fixed Kube reader, never exposed to public request selection. */
export interface ProofKubeReadClient {
 json(path:string,signal:AbortSignal):Promise<unknown>;
 log(path:string,signal:AbortSignal):Promise<string>;
}

export interface ComputeProofAdmissionLease {
 readonly signal:AbortSignal;
 release():Promise<void>;
}
export interface ComputeProofAdmissionPort {
 acquire(input:ComputeReleaseProofInput,signal:AbortSignal):Promise<ComputeProofAdmissionLease>;
}
