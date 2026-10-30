// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Parse before IO; hash every parsed field with RFC8785 key/number/string ordering. */
import { createHash } from "node:crypto";
import { COMPUTE_PROOF_BODY_BYTES, ComputeProofRequestSchema, type ComputeProofRequest } from "@/contracts/compute.release-proof.v1.contract";
export { canonicalProofJson } from "@/shared/compute-release-proof-canonical";
import { canonicalProofJson } from "@/shared/compute-release-proof-canonical";
export function parseComputeProof(body: string): ComputeProofRequest {
 if(Buffer.byteLength(body)>COMPUTE_PROOF_BODY_BYTES) throw new Error("invalid_proof");
 return ComputeProofRequestSchema.parse(JSON.parse(body));
}
export function computeProofHash(request: ComputeProofRequest): string {
 return createHash("sha256").update(canonicalProofJson(ComputeProofRequestSchema.parse(request))).digest("hex");
}
