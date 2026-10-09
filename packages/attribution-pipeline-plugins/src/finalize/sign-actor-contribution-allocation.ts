// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins/finalize/sign-actor-contribution-allocation`
 * Purpose: Resolve, verify, and persist one signed actor contribution allocation.
 * Scope: Orchestration over AttributionStore plus viem signature verification. Does not infer ownership or beneficiary policy.
 * Invariants: EXPLICIT_BENEFICIARY; SOURCE_OWNER_AT_CUTOFF; LEGACY_STATEMENT_UNCHANGED.
 * Side-effects: IO (AttributionStore DB reads/writes and viem EIP-712 verification).
 * Links: story.5075, task.5219
 * @public
 */

import {
  type ActorContributionAllocationRecord,
  type AttributionStore,
  buildActorContributionAllocationTypedData,
} from "@cogni/attribution-ledger";
import { verifyTypedData } from "viem";

export interface SignActorContributionAllocationDeps {
  readonly attributionStore: AttributionStore;
  readonly nodeId: string;
  readonly chainId: number;
  readonly deploymentEnvironment?: string | undefined;
  readonly now?: () => Date;
}

export interface SignActorContributionAllocationInput {
  readonly epochId: string;
  readonly receiptId: string;
  readonly signerActorId: string;
  readonly signerAddress: string;
  readonly signature: string;
}

/** Freeze at receipt event_time, verify the authorizer wallet, then persist. */
export async function signActorContributionAllocation(
  deps: SignActorContributionAllocationDeps,
  input: SignActorContributionAllocationInput
): Promise<ActorContributionAllocationRecord> {
  const allocation =
    await deps.attributionStore.prepareActorContributionAllocation({
      nodeId: deps.nodeId,
      epochId: BigInt(input.epochId),
      receiptId: input.receiptId,
    });
  const signerOwnsWallet = await deps.attributionStore.actorOwnsSigningWallet({
    actorId: input.signerActorId,
    wallet: input.signerAddress,
  });
  if (!signerOwnsWallet) {
    throw new Error("Actor allocation signer does not own the signing wallet");
  }
  const typedData = buildActorContributionAllocationTypedData({
    allocation,
    chainId: deps.chainId,
    deploymentEnvironment: deps.deploymentEnvironment,
  });
  const signatureValid = await verifyTypedData({
    address: input.signerAddress as `0x${string}`,
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
    signature: input.signature as `0x${string}`,
  });
  if (!signatureValid) throw new Error("Actor allocation signature is invalid");

  return deps.attributionStore.insertSignedActorContributionAllocation({
    allocation,
    signerActorId: input.signerActorId,
    signerWallet: input.signerAddress,
    signature: input.signature,
    signedAt: (deps.now ?? (() => new Date()))(),
  });
}
