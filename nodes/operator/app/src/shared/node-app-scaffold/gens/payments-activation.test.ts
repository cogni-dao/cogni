// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/payments-activation`
 * Purpose: Pin the payment-activation repo-spec splice - payments_in (95/5) + active status are
 *   written (never a node_wallet block, bug.5656), the result stays parseable YAML, comments survive, and a re-splice is a no-op.
 * Scope: Pure unit test over `renderPaymentsActivationSpec`. No IO.
 * Invariants: AT_COST_ECONOMICS, SINGLE_HOME, IDEMPOTENT_SPLICE.
 * Side-effects: none.
 * Links: src/shared/node-app-scaffold/gens/payments-activation
 * @public
 */

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  ACTIVATION_MARKUP_FACTOR,
  ACTIVATION_REVENUE_SHARE,
  hasPaymentsActivationSpec,
  renderPaymentsActivationSpec,
} from "./payments-activation";

const OPERATOR_WALLET = "0x1111111111111111111111111111111111111111";
const SPLIT = "0x2222222222222222222222222222222222222222";

const PENDING_SPEC = `# Node Template - repo-spec
schema_version: "0.1.4"

node_id: "abc"
scope_id: "def"
scope_key: "default"

intent:
  name: atlas
  mission: "do things"

governance:
  dao_contract: "0xDA0"
  chain_id: "8453"

operator_wallet:
  address: "${OPERATOR_WALLET}"

payments:
  status: pending_activation

gates:
  - type: review-limits
    id: review_limits
`;

describe("renderPaymentsActivationSpec", () => {
  const activated = renderPaymentsActivationSpec(PENDING_SPEC, {
    splitAddress: SPLIT,
  });

  it("writes payments_in (95/5) and flips status to active, never a node_wallet block", () => {
    const parsed = parseYaml(activated) as Record<string, unknown>;
    expect(parsed.node_wallet).toBeUndefined();
    expect(activated).not.toContain("node_wallet");
    expect((parsed.operator_wallet as Record<string, unknown>).address).toBe(
      OPERATOR_WALLET
    );
    const topup = (
      parsed.payments_in as Record<string, Record<string, unknown>>
    ).credits_topup as Record<string, unknown>;
    expect(topup.receiving_address).toBe(SPLIT);
    expect(topup.markup_factor).toBe(ACTIVATION_MARKUP_FACTOR);
    expect(topup.revenue_share).toBe(ACTIVATION_REVENUE_SHARE);
    expect(topup.allowed_chains).toEqual(["Base"]);
    expect(topup.allowed_tokens).toEqual(["USDC"]);
    expect((parsed.payments as Record<string, unknown>).status).toBe("active");
  });

  it("preserves identity + comments + gates from the original spec", () => {
    expect(activated).toContain("# Node Template - repo-spec");
    expect(activated).toContain('node_id: "abc"');
    const parsed = parseYaml(activated) as Record<string, unknown>;
    expect((parsed.governance as Record<string, unknown>).dao_contract).toBe(
      "0xDA0"
    );
    expect(Array.isArray(parsed.gates)).toBe(true);
  });

  it("is idempotent when re-splicing an activated spec", () => {
    const twice = renderPaymentsActivationSpec(activated, {
      splitAddress: SPLIT,
    });
    expect(twice).toBe(activated);
    expect(
      hasPaymentsActivationSpec(twice, {
        nodeWalletAddress: OPERATOR_WALLET,
        splitAddress: SPLIT,
      })
    ).toBe(true);
  });

  it("recognizes semantically active specs even when block placement differs", () => {
    const reordered = `${PENDING_SPEC.replace("  status: pending_activation", "  status: active").replace(OPERATOR_WALLET, OPERATOR_WALLET.toUpperCase())}

payments_in:
  credits_topup:
    provider: cogni-usdc-backend-v1
    receiving_address: "${SPLIT.toUpperCase()}"
    allowed_chains:
      - Base
    allowed_tokens:
      - USDC
    markup_factor: ${ACTIVATION_MARKUP_FACTOR}
    revenue_share: ${ACTIVATION_REVENUE_SHARE}
`;

    expect(
      hasPaymentsActivationSpec(reordered, {
        nodeWalletAddress: OPERATOR_WALLET,
        splitAddress: SPLIT,
      })
    ).toBe(true);
  });

  it("re-splices new values onto an already-activated spec", () => {
    const newSplit = "0x3333333333333333333333333333333333333333";
    const next = renderPaymentsActivationSpec(activated, {
      splitAddress: newSplit,
    });
    const parsed = parseYaml(next) as Record<string, unknown>;
    const topup = (
      parsed.payments_in as Record<string, Record<string, unknown>>
    ).credits_topup as Record<string, unknown>;
    expect(topup.receiving_address).toBe(newSplit);
    expect((parsed.payments as Record<string, unknown>).status).toBe("active");
  });

  it("appends payments block when the source spec has none", () => {
    const noPayments = `node_id: "abc"\nintent:\n  name: atlas\n`;
    const out = renderPaymentsActivationSpec(noPayments, {
      splitAddress: SPLIT,
    });
    const parsed = parseYaml(out) as Record<string, unknown>;
    expect((parsed.payments as Record<string, unknown>).status).toBe("active");
    expect(parsed.node_wallet).toBeUndefined();
  });

  it("does not report active when operator_wallet is missing or differs", () => {
    const noWallet = activated.replace(
      /operator_wallet:\n {2}address: "[^"]*"\n\n/,
      ""
    );
    expect(noWallet).not.toContain("operator_wallet");
    expect(
      hasPaymentsActivationSpec(noWallet, {
        nodeWalletAddress: OPERATOR_WALLET,
        splitAddress: SPLIT,
      })
    ).toBe(false);
    expect(
      hasPaymentsActivationSpec(activated, {
        nodeWalletAddress: "0x4444444444444444444444444444444444444444",
        splitAddress: SPLIT,
      })
    ).toBe(false);
  });
});
