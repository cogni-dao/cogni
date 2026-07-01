// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/distribution-activation`
 * Purpose: Pin the distribution-activation repo-spec splice: token + emissions holder are written,
 *   distributions become active, the OSS claim pattern is explicit, the ONE deployed distributor
 *   (address + chain + deploy tx) is recorded, comments survive, and re-splice is a no-op.
 * Scope: Pure unit test over `renderDistributionActivationSpec`. No IO.
 * Invariants: OSS_CLAIM_PATH, NON_LINEAR_ACTIVATION, SINGLE_HOME, IDEMPOTENT_SPLICE.
 * Side-effects: none.
 * Links: src/shared/node-app-scaffold/gens/distribution-activation
 * @public
 */

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  DISTRIBUTION_CLAIM_CONTRACT_PATTERN,
  hasDistributionActivationSpec,
  renderDistributionActivationSpec,
} from "./distribution-activation";

const TOKEN = "0x2222222222222222222222222222222222222222";
const EMISSIONS_HOLDER = "0x3333333333333333333333333333333333333333";
const DISTRIBUTOR = "0x6666666666666666666666666666666666666666";
const DEPLOY_TX = `0x${"ab".repeat(32)}`;

const INPUT = {
  tokenAddress: TOKEN,
  emissionsHolderAddress: EMISSIONS_HOLDER,
  distributorAddress: DISTRIBUTOR,
  distributorDeployTx: DEPLOY_TX,
};

const PENDING_SPEC = `# Node Template - repo-spec
schema_version: "0.1.4"

node_id: "abc"
scope_id: "def"
scope_key: "default"

intent:
  name: atlas
  mission: "do things"

governance:
  dao_contract: "0x1111111111111111111111111111111111111111"
  plugin_contract: "0x4444444444444444444444444444444444444444"
  signal_contract: "0x5555555555555555555555555555555555555555"
  chain_id: "8453"

distributions:
  status: pending_activation

gates:
  - type: review-limits
    id: review_limits
`;

describe("renderDistributionActivationSpec", () => {
  const activated = renderDistributionActivationSpec(PENDING_SPEC, INPUT);

  it("writes token, emissions holder, active status, the OSS claim pattern, and the distributor", () => {
    const parsed = parseYaml(activated) as Record<string, unknown>;
    const governance = parsed.governance as Record<string, unknown>;
    const distributions = parsed.distributions as Record<string, unknown>;

    expect(governance.token_contract).toBe(TOKEN);
    expect(governance.emissions_holder).toBe(EMISSIONS_HOLDER);
    expect(distributions.status).toBe("active");
    expect(distributions.claim_contract_pattern).toBe(
      DISTRIBUTION_CLAIM_CONTRACT_PATTERN
    );
    expect(distributions.distributor_address).toBe(DISTRIBUTOR);
    expect(distributions.distributor_deploy_tx).toBe(DEPLOY_TX);
  });

  it("preserves existing governance identity and comments", () => {
    expect(activated).toContain("# Node Template - repo-spec");
    expect(activated).toContain(
      'dao_contract: "0x1111111111111111111111111111111111111111"'
    );
    const parsed = parseYaml(activated) as Record<string, unknown>;
    expect(Array.isArray(parsed.gates)).toBe(true);
  });

  it("is idempotent when re-splicing an activated spec", () => {
    const twice = renderDistributionActivationSpec(activated, INPUT);
    expect(twice).toBe(activated);
    expect(hasDistributionActivationSpec(twice, INPUT)).toBe(true);
  });

  it("recognizes semantically active specs even when block placement differs", () => {
    const reordered = `# Node Template - repo-spec
schema_version: "0.1.4"

node_id: "abc"
scope_id: "def"
scope_key: "default"

distributions:
  status: active
  claim_contract_pattern: ${DISTRIBUTION_CLAIM_CONTRACT_PATTERN}
  distributor_address: "${DISTRIBUTOR.toUpperCase()}"
  distributor_deploy_tx: "${DEPLOY_TX}"

governance:
  dao_contract: "0x1111111111111111111111111111111111111111"
  plugin_contract: "0x4444444444444444444444444444444444444444"
  signal_contract: "0x5555555555555555555555555555555555555555"
  chain_id: "8453"
  token_contract: "${TOKEN.toUpperCase()}"
  emissions_holder: "${EMISSIONS_HOLDER.toUpperCase()}"
`;

    expect(hasDistributionActivationSpec(reordered, INPUT)).toBe(true);
  });

  it("updates already-present distribution addresses", () => {
    const old = renderDistributionActivationSpec(PENDING_SPEC, {
      tokenAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      emissionsHolderAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      distributorAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
      distributorDeployTx: `0x${"cd".repeat(32)}`,
    });
    const next = renderDistributionActivationSpec(old, INPUT);
    const parsed = parseYaml(next) as Record<string, unknown>;
    const governance = parsed.governance as Record<string, unknown>;
    const distributions = parsed.distributions as Record<string, unknown>;
    expect(governance.token_contract).toBe(TOKEN);
    expect(governance.emissions_holder).toBe(EMISSIONS_HOLDER);
    expect(distributions.distributor_address).toBe(DISTRIBUTOR);
    expect(distributions.distributor_deploy_tx).toBe(DEPLOY_TX);
  });
});
