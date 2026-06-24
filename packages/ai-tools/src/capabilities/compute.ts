// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/capabilities/compute`
 * Purpose: Compute-substrate capability — the typed control plane's read over the compute provider account(s) that fund the node network's VMs (cost/balance awareness); the write half (provision/release/settle) is funding-gated.
 * Scope: Defines the read-only v0 ComputeResourcePort + the provider-agnostic ComputeBalance type. Does NOT implement transport, provision/release compute, or settle payment.
 * Invariants:
 *   - CAPABILITY_INJECTION: Implementation injected at bootstrap, not imported.
 *   - PROVIDER_AGNOSTIC: Types speak uniform units (currency + remaining), never provider units.
 *     Cherry credit/promo shape, Akash uakt/escrow — none of it escapes the adapter.
 *   - ADAPTER_SWAPPABLE: CherryComputeAdapter today, AkashComputeAdapter later — a 1:1 swap;
 *     the interface never names a provider.
 *   - READ_NOW_SETTLE_LATER: balance/cost reads are NOT Akash-gated and ship now. Only the
 *     write verbs (provision/release/settle — settle being Cosmos/axlUSDC) wait on Akash funding.
 * Side-effects: none (interface only)
 * Links: docs/spec/cicd-platform-boundary.md § "The next layer: a typed operator control plane",
 *   story.5011 (preview balance-suspension incident), sibling of ./deploy DeployCapability.
 * @public
 */

/**
 * Provider-agnostic balance for one compute provider account.
 *
 * `remaining` is expressed in `currency` major units (ISO 4217). `provider`/`accountId`
 * are opaque labels for observability + alert routing — callers MUST NOT branch on them
 * (that would re-leak provider specifics the adapter exists to contain).
 */
export interface ComputeBalance {
  /** Opaque provider label, e.g. "cherry" / "akash". For labeling, never branched on. */
  readonly provider: string;
  /** Opaque provider account/team identifier. */
  readonly accountId: string;
  /** ISO 4217 currency code of `remaining`, e.g. "EUR" / "USD". */
  readonly currency: string;
  /** Remaining balance in `currency` major units. */
  readonly remaining: number;
  /** ISO 8601 timestamp the balance was read. */
  readonly asOf: string;
  /**
   * Estimated days of runway at current burn, or `null` when burn-rate is unknown
   * (v0 reads a single balance with no usage history, so this is null until a
   * burn-rate read lands).
   */
  readonly estimatedDaysRemaining: number | null;
}

/**
 * Compute-substrate capability.
 *
 * READ-ONLY v0 (this file). The write half — `provision` / `release` / `settle` — is the
 * funding-gated complement and is deliberately NOT declared here yet; only `settle()`
 * (Cosmos multisig / axlUSDC) is genuinely Akash-shaped, so it lands with the Akash adapter.
 */
export interface ComputeResourcePort {
  /**
   * Read the current balance of every configured compute provider account.
   *
   * Returns one entry per account so the awareness surface (scheduled emitter + dashboard)
   * covers each provider uniformly. Returns an empty array when no provider is configured.
   */
  balances(): Promise<readonly ComputeBalance[]>;
}
