// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-ledger/signing`
 * Purpose: EIP-712 typed data builder, EIP-191 canonical message builder (deprecated), and approver set hashing for payout statement signing.
 * Scope: Pure functions. Does not perform network I/O or hold secrets. Does not import viem — returns plain objects matching viem's expected shape.
 * Invariants:
 * - SIGNATURE_SCOPE_BOUND: Typed data includes node_id + scope_id + epoch_id + allocation_set_hash + pool_total_credits + chainId.
 * - SIGNATURE_DEPLOYMENT_BOUND: Typed data includes the server-validated deployment environment so signatures cannot replay across environments.
 * - APPROVERS_PINNED_AT_REVIEW: computeApproverSetHash produces a deterministic SHA-256 from sorted, lowercased addresses.
 * - EIP712_DETERMINISTIC: Same inputs → identical typed data object (no timestamps, no randomness).
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

/**
 * Compute SHA-256 hash of a UTF-8 string using Web Crypto API (no node:crypto).
 * Returns lowercase hex string. Async because crypto.subtle.digest is async.
 */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface CanonicalMessageParams {
  readonly nodeId: string;
  readonly scopeId: string;
  /** Epoch ID as string (bigint serialized) */
  readonly epochId: string;
  readonly finalAllocationSetHash: string;
  /** Pool total credits as string (bigint serialized) */
  readonly poolTotalCredits: string;
}

/**
 * Build the EIP-191 canonical message for payout statement signing.
 * Newline is always \n (no \r). Tests must assert exact bytes.
 * @deprecated Use `buildEIP712TypedData()` for EIP-712 structured signing. Retained for one release cycle.
 */
export function buildCanonicalMessage(params: CanonicalMessageParams): string {
  return [
    "Cogni Attribution Statement v1",
    `Node: ${params.nodeId}`,
    `Scope: ${params.scopeId}`,
    `Epoch: ${params.epochId}`,
    `Final Allocation Hash: ${params.finalAllocationSetHash}`,
    `Pool Total: ${params.poolTotalCredits}`,
  ].join("\n");
}

// ── EIP-712 Typed Data ──────────────────────────────────────────────────────

/**
 * EIP-712 domain separator for Cogni Attribution.
 * chainId must be passed in — this package cannot import from src/shared/web3.
 */
export const EIP712_DOMAIN_NAME = "Cogni Attribution" as const;
export const EIP712_DOMAIN_VERSION = "2" as const;

/**
 * Environments allowed to mint EIP-712 attribution statements. Production-like
 * deployments use candidate-a/preview/production; local/test keep development
 * and automated tests isolated without inventing a second configuration seam.
 */
export const EIP712_DEPLOYMENT_ENVIRONMENTS = [
  "local",
  "test",
  "candidate-a",
  "preview",
  "production",
] as const;

export type EIP712DeploymentEnvironment =
  (typeof EIP712_DEPLOYMENT_ENVIRONMENTS)[number];

/** Fail closed at the server authority boundary on missing/unknown config. */
export function parseEIP712DeploymentEnvironment(
  value: string | undefined
): EIP712DeploymentEnvironment {
  if (
    value !== undefined &&
    (EIP712_DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(value)
  ) {
    return value as EIP712DeploymentEnvironment;
  }
  throw new Error(
    `DEPLOY_ENVIRONMENT must be one of ${EIP712_DEPLOYMENT_ENVIRONMENTS.join(
      ", "
    )}; received ${value === undefined ? "<unset>" : JSON.stringify(value)}`
  );
}

/** EIP-712 types for the AttributionStatement primary type. */
export const ATTRIBUTION_STATEMENT_TYPES = {
  AttributionStatement: [
    { name: "nodeId", type: "string" },
    { name: "scopeId", type: "string" },
    { name: "epochId", type: "string" },
    { name: "deploymentEnvironment", type: "string" },
    { name: "finalAllocationSetHash", type: "string" },
    { name: "poolTotalCredits", type: "string" },
  ],
} as const;

export interface EIP712TypedData {
  readonly domain: {
    readonly name: string;
    readonly version: string;
    readonly chainId: number;
  };
  readonly types: typeof ATTRIBUTION_STATEMENT_TYPES;
  readonly primaryType: "AttributionStatement";
  readonly message: {
    readonly nodeId: string;
    readonly scopeId: string;
    readonly epochId: string;
    readonly deploymentEnvironment: EIP712DeploymentEnvironment;
    readonly finalAllocationSetHash: string;
    readonly poolTotalCredits: string;
  };
}

export interface EIP712TypedDataParams extends CanonicalMessageParams {
  readonly chainId: number;
  readonly deploymentEnvironment: EIP712DeploymentEnvironment;
}

/**
 * Build EIP-712 typed data for payout statement signing.
 * Returns a plain object matching viem's `SignTypedDataParameters` shape.
 * SIGNATURE_SCOPE_BOUND: includes nodeId, scopeId, epochId, finalAllocationSetHash, poolTotalCredits, chainId.
 * SIGNATURE_DEPLOYMENT_BOUND: includes deploymentEnvironment in the wallet-visible message.
 * EIP712_DETERMINISTIC: same inputs → identical output.
 */
export function buildEIP712TypedData(
  params: EIP712TypedDataParams
): EIP712TypedData {
  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: params.chainId,
    },
    types: ATTRIBUTION_STATEMENT_TYPES,
    primaryType: "AttributionStatement",
    message: {
      nodeId: params.nodeId,
      scopeId: params.scopeId,
      epochId: params.epochId,
      deploymentEnvironment: params.deploymentEnvironment,
      finalAllocationSetHash: params.finalAllocationSetHash,
      poolTotalCredits: params.poolTotalCredits,
    },
  };
}

/**
 * Compute deterministic hash of an approver set for pinning at closeIngestion.
 * Sorted, lowercased, SHA-256 via Web Crypto API (no node:crypto dependency).
 */
export async function computeApproverSetHash(
  approvers: readonly string[]
): Promise<string> {
  const canonical = [...approvers]
    .map((a) => a.toLowerCase())
    .sort()
    .join(",");
  return sha256Hex(canonical);
}
