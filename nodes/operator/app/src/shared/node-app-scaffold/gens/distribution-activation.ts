// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/distribution-activation`
 * Purpose: Pure splice of token-distribution activation config into an EXISTING node repo-spec YAML:
 *   `governance.token_contract`, `governance.emissions_holder`, and `distributions.status: active`
 *   with the vendored 1inch CumulativeMerkleDrop claim pattern pinned.
 * Scope: Pure string transform over the current `.cogni/repo-spec.yaml` text. No IO, no env, no
 *   YAML round-trip; comments and top-level ordering survive. The route reads the current file and
 *   persists this result through a node-repo PR.
 * Invariants:
 *   - OSS_CLAIM_PATH: pins `1inch.cumulative-merkle-drop.v1` (the vendored distributor); no bespoke
 *     distributor contract.
 *   - NON_LINEAR_ACTIVATION: operates on an existing node repo-spec; does not require replaying
 *     formation or payments activation.
 *   - SINGLE_HOME: writes ONLY to the node's own `.cogni/repo-spec.yaml`.
 *   - IDEMPOTENT_SPLICE: re-splicing an already-activated spec is a no-op.
 * Side-effects: none.
 * Links: https://cognidao.org/knowledge/node-formation-contract, https://cognidao.org/knowledge/tokenomics-budget-policy, task.0135
 * @public
 */

import { parse as parseYaml } from "yaml";

// The claim pattern MUST name the distributor the node actually deploys +
// claims against. Activation deploys the vendored 1inch CumulativeMerkleDrop
// (`CUMULATIVE_MERKLE_DISTRIBUTOR_BYTECODE`), the on-chain guard reads its
// `merkleRoot()`, and the live R3/R4 pipeline builds a
// `1inch.cumulative-merkle-drop.v1` cumulative manifest — so the record must be
// `1inch.cumulative-merkle-drop.v1`, not the legacy non-cumulative
// `uniswap.merkle-distributor.v1`. ONE canonical OSS distributor pattern
// (bug.5031): record follows code.
export const DISTRIBUTION_CLAIM_CONTRACT_PATTERN =
  "1inch.cumulative-merkle-drop.v1" as const;

export interface RenderDistributionActivationInput {
  /** Aragon GovernanceERC20 token used for contributor distributions. */
  readonly tokenAddress: string;
  /** DAO-controlled holder/vault containing minted inventory for epoch distributions. */
  readonly emissionsHolderAddress: string;
  /**
   * DEPLOYED CumulativeMerkleDistributor address (owned by the DAO, `token()` == the node token).
   * Optional: when present, `distributions.distributor_address` is written so claims can read it.
   * Absent ⇒ metadata-only activation (readiness recorded, no distributor pinned yet).
   */
  readonly distributorAddress?: string;
}

const DISTRIBUTIONS_BLOCK = `distributions:
  status: active
  claim_contract_pattern: ${DISTRIBUTION_CLAIM_CONTRACT_PATTERN}`;

/**
 * Splice distribution activation config into an existing repo-spec YAML string.
 *
 * Strategy:
 *   1. Upsert `governance.token_contract`.
 *   2. Upsert `governance.emissions_holder`.
 *   3. Upsert `distributions.status: active`.
 *   4. Upsert `distributions.claim_contract_pattern: 1inch.cumulative-merkle-drop.v1`.
 *   5. When a distributor is supplied, upsert `distributions.distributor_address`.
 */
export function renderDistributionActivationSpec(
  current: string,
  input: RenderDistributionActivationInput
): string {
  let out = current.replace(/\s*$/, "\n");

  out = upsertGovernanceDistributionFields(out, input);
  out = upsertDistributionsBlock(out, input.distributorAddress);

  return out.replace(/\n*$/, "\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sameAddress(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

/**
 * Semantic guard for already-open activation PR branches. Rendering from `main` is deterministic, but
 * existing activation branches may have equivalent block placement or whitespace.
 */
export function hasDistributionActivationSpec(
  spec: string,
  input: RenderDistributionActivationInput
): boolean {
  let parsed: unknown;
  try {
    parsed = parseYaml(spec);
  } catch {
    return false;
  }

  const root = asRecord(parsed);
  const governance = asRecord(root?.governance);
  const distributions = asRecord(root?.distributions);
  if (!root || !governance || !distributions) return false;

  // When a distributor is requested, the spec must already pin THAT exact
  // address for the guard to short-circuit (an already-active metadata-only spec
  // still needs the distributor splice).
  const distributorMatches =
    input.distributorAddress === undefined ||
    sameAddress(distributions.distributor_address, input.distributorAddress);

  return (
    distributions.status === "active" &&
    distributions.claim_contract_pattern ===
      DISTRIBUTION_CLAIM_CONTRACT_PATTERN &&
    sameAddress(governance.token_contract, input.tokenAddress) &&
    sameAddress(governance.emissions_holder, input.emissionsHolderAddress) &&
    distributorMatches
  );
}

function topLevelBlockRegex(key: string): RegExp {
  return new RegExp(`(^|\\n)${key}:[^\\n]*(?:\\n[ \\t]+[^\\n]*)*`, "m");
}

function upsertIndentedScalar(
  block: string,
  key: string,
  value: string
): string {
  const line = `  ${key}: "${value}"`;
  const re = new RegExp(`^([ \\t]+)${key}:[^\\n]*$`, "m");
  if (re.test(block)) {
    return block.replace(re, line);
  }
  return `${block.replace(/\n*$/, "")}\n${line}`;
}

function upsertGovernanceDistributionFields(
  spec: string,
  input: RenderDistributionActivationInput
): string {
  const re = topLevelBlockRegex("governance");
  const match = re.exec(spec);
  if (!match) {
    return `${spec.replace(/\n*$/, "\n")}\ngovernance:\n  token_contract: "${input.tokenAddress}"\n  emissions_holder: "${input.emissionsHolderAddress}"\n`;
  }

  const leading = match[1] ?? "";
  let body = match[0].slice(leading.length);
  body = upsertIndentedScalar(body, "token_contract", input.tokenAddress);
  body = upsertIndentedScalar(
    body,
    "emissions_holder",
    input.emissionsHolderAddress
  );
  return spec.replace(re, `${leading}${body}`);
}

function upsertDistributionsBlock(
  spec: string,
  distributorAddress?: string
): string {
  const distributorLine = distributorAddress
    ? `\n  distributor_address: "${distributorAddress}"`
    : "";
  const re = topLevelBlockRegex("distributions");
  const match = re.exec(spec);
  if (!match) {
    return `${spec.replace(/\n*$/, "\n")}\n${DISTRIBUTIONS_BLOCK}${distributorLine}\n`;
  }

  const leading = match[1] ?? "";
  let body = match[0].slice(leading.length);
  body = upsertDistributionField(body, "status", "active");
  body = upsertDistributionField(
    body,
    "claim_contract_pattern",
    DISTRIBUTION_CLAIM_CONTRACT_PATTERN
  );
  // Only pin the distributor when one was deployed; a bare quoted address keeps
  // the value readable by the claim path (yaml string, checksummed 0x…).
  if (distributorAddress) {
    body = upsertDistributionField(
      body,
      "distributor_address",
      `"${distributorAddress}"`
    );
  }
  return spec.replace(re, `${leading}${body}`);
}

function upsertDistributionField(
  block: string,
  key: string,
  value: string
): string {
  const line = `  ${key}: ${value}`;
  const re = new RegExp(`^([ \\t]+)${key}:[^\\n]*$`, "m");
  if (re.test(block)) {
    return block.replace(re, line);
  }
  return `${block.replace(/\n*$/, "")}\n${line}`;
}
