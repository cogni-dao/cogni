// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/payments-activation`
 * Purpose: Pure splice of payment-activation config into an EXISTING node repo-spec YAML — the
 *   `node_wallet.address`, `payments_in.credits_topup.*` (95/5 at-cost economics), and
 *   `payments.status: active` blocks the operator writes back into the node's OWN repo when a
 *   founder activates payments.
 * Scope: Pure string transform over the current `.cogni/repo-spec.yaml` text. No IO, no env, no
 *   YAML round-trip (a string splice, so the spec's comments + ordering are preserved). The route
 *   layer reads the current file via the App and persists the result via a PR.
 * Invariants:
 *   - AT_COST_ECONOMICS: `markup_factor` + `revenue_share` are fixed at the 95/5 at-cost defaults
 *     (matches the activation UI + `@cogni/operator-wallet` split math); callers do not parameterize
 *     them, so a node can never be born with off-economics defaults.
 *   - SINGLE_HOME: writes ONLY to the node's own `.cogni/repo-spec.yaml` — never a `nodes/<x>/` path.
 *   - IDEMPOTENT_SPLICE: re-splicing an already-activated spec is a no-op (the blocks converge on the
 *     same values), so re-running activation produces an empty diff.
 * Side-effects: none
 * Links: src/shared/node-app-scaffold/gens/repo-spec.ts, docs/design/node-payments-activation.md, task.5083
 * @public
 */

/** Default payment activation economics: ~95% provider top-up / ~5% DAO margin (at-cost). */
export const ACTIVATION_MARKUP_FACTOR = 1.10803324099723;
export const ACTIVATION_REVENUE_SHARE = 0;

export interface RenderPaymentsActivationInput {
  /** The node's own Privy/operator wallet address (checksummed) → `node_wallet.address`. */
  readonly nodeWalletAddress: string;
  /** The deployed 0xSplits V2 Split → `payments_in.credits_topup.receiving_address`. */
  readonly splitAddress: string;
}

const NODE_WALLET_BLOCK = (address: string): string =>
  `node_wallet:
  address: "${address}"`;

const PAYMENTS_IN_BLOCK = (splitAddress: string): string =>
  `payments_in:
  credits_topup:
    provider: cogni-usdc-backend-v1
    receiving_address: "${splitAddress}"
    allowed_chains:
      - Base
    allowed_tokens:
      - USDC
    markup_factor: ${ACTIVATION_MARKUP_FACTOR}
    revenue_share: ${ACTIVATION_REVENUE_SHARE}`;

/**
 * Splice payment-activation config into an existing repo-spec YAML string.
 *
 * Strategy (string splice, comment-preserving):
 *   1. Flip the existing `payments:` block to `status: active` (replace `pending_activation`); if no
 *      `payments:` block exists, append `payments:\n  status: active`.
 *   2. Upsert the `node_wallet:` block (replace if present, else insert before `payments:`/append).
 *   3. Upsert the `payments_in:` block (replace if present, else insert before `payments:`/append).
 *
 * The result is deterministic + idempotent: a spec already carrying these exact blocks splices to an
 * identical string.
 */
export function renderPaymentsActivationSpec(
  current: string,
  input: RenderPaymentsActivationInput
): string {
  let out = current.replace(/\s*$/, "\n");

  out = upsertTopLevelBlock(
    out,
    "node_wallet",
    NODE_WALLET_BLOCK(input.nodeWalletAddress)
  );
  out = upsertTopLevelBlock(
    out,
    "payments_in",
    PAYMENTS_IN_BLOCK(input.splitAddress)
  );
  out = upsertPaymentsStatus(out);

  return out.replace(/\n*$/, "\n");
}

/**
 * Match a top-level YAML block: a line `^key:` and every following INDENTED line, stopping at the
 * first blank line or next top-level key (column-0, non-comment). Deliberately does NOT swallow the
 * trailing blank separator line — so replacing a block can never glue the next block onto it (the
 * idempotency bug). Top-level keys start at column 0.
 */
function topLevelBlockRegex(key: string): RegExp {
  // `key:` line, then a run of indented continuation lines (`\n` + at least one space/tab).
  return new RegExp(`(^|\\n)${key}:[^\\n]*(?:\\n[ \\t]+[^\\n]*)*`, "m");
}

/** Replace an existing top-level block with `block`, or append it if absent. */
function upsertTopLevelBlock(spec: string, key: string, block: string): string {
  const re = topLevelBlockRegex(key);
  const match = re.exec(spec);
  if (match) {
    const leading = match[1] ?? "";
    return spec.replace(re, `${leading}${block}`);
  }
  return `${spec.replace(/\n*$/, "\n")}\n${block}\n`;
}

/**
 * Set `payments.status: active`. If a `payments:` block exists, replace its `status:` line (or append
 * one); otherwise append a fresh `payments:\n  status: active` block.
 */
function upsertPaymentsStatus(spec: string): string {
  const re = topLevelBlockRegex("payments");
  const match = re.exec(spec);
  if (!match) {
    return `${spec.replace(/\n*$/, "\n")}\npayments:\n  status: active\n`;
  }
  const block = match[0];
  const leading = match[1] ?? "";
  const body = block.slice(leading.length);
  let newBody: string;
  if (/^\s+status:[^\n]*$/m.test(body)) {
    newBody = body.replace(/^(\s+)status:[^\n]*$/m, "$1status: active");
  } else {
    newBody = `${body.replace(/\n*$/, "")}\n  status: active`;
  }
  return spec.replace(re, `${leading}${newBody}`);
}
