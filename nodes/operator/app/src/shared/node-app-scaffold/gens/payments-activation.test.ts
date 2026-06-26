// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/payments-activation`
 * Purpose: Pin the payment-activation repo-spec splice — node_wallet + payments_in (95/5) + active
 *   status are written, the result stays parseable YAML, comments survive, and a re-splice is a no-op.
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
  renderPaymentsActivationSpec,
} from "./payments-activation";

const NODE_WALLET = "0x1111111111111111111111111111111111111111";
const SPLIT = "0x2222222222222222222222222222222222222222";

const PENDING_SPEC = `# Node Template — repo-spec
schema_version: "0.1.4"

node_id: "abc"
scope_id: "def"
scope_key: "default"

intent:
  name: atlas
  mission: "do things"

cogni_dao:
  dao_contract: "0xDA0"
  chain_id: "8453"

payments:
  status: pending_activation

gates:
  - type: review-limits
    id: review_limits
`;

describe("renderPaymentsActivationSpec", () => {
  const activated = renderPaymentsActivationSpec(PENDING_SPEC, {
    nodeWalletAddress: NODE_WALLET,
    splitAddress: SPLIT,
  });

  it("writes node_wallet, payments_in (95/5), and flips status to active", () => {
    const parsed = parseYaml(activated) as Record<string, unknown>;
    expect((parsed.node_wallet as Record<string, unknown>).address).toBe(
      NODE_WALLET
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
    expect(activated).toContain("# Node Template — repo-spec");
    expect(activated).toContain('node_id: "abc"');
    const parsed = parseYaml(activated) as Record<string, unknown>;
    expect((parsed.cogni_dao as Record<string, unknown>).dao_contract).toBe(
      "0xDA0"
    );
    expect(Array.isArray(parsed.gates)).toBe(true);
  });

  it("is idempotent — re-splicing an activated spec is a no-op", () => {
    const twice = renderPaymentsActivationSpec(activated, {
      nodeWalletAddress: NODE_WALLET,
      splitAddress: SPLIT,
    });
    expect(twice).toBe(activated);
  });

  it("re-splices new values onto an already-activated spec", () => {
    const newSplit = "0x3333333333333333333333333333333333333333";
    const next = renderPaymentsActivationSpec(activated, {
      nodeWalletAddress: NODE_WALLET,
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
      nodeWalletAddress: NODE_WALLET,
      splitAddress: SPLIT,
    });
    const parsed = parseYaml(out) as Record<string, unknown>;
    expect((parsed.payments as Record<string, unknown>).status).toBe("active");
    expect((parsed.node_wallet as Record<string, unknown>).address).toBe(
      NODE_WALLET
    );
  });
});
