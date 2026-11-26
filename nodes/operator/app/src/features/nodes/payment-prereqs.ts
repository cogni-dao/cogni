// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/payment-prereqs`
 * Purpose: Pure rules for the payment prerequisites a node declares in its own repo-spec
 *   (`operator_wallet.address` + the `governance` DAO block): where to read the spec, how to
 *   validate it, and what to do with the registry row given its current status (bug.5656).
 * Scope: No IO, no env. The route does the GitHub read, the on-chain code check and the write.
 * Invariants:
 *   - GIT_IS_THE_SOURCE: addresses come from the node repo-spec on `main`, never from a request body.
 *   - NEVER_OVERWRITE: a non-null row address that differs from git is a conflict (`prereq_mismatch`),
 *     never silently replaced. A null row address is "record it".
 *   - CHECKSUM_AND_NONZERO: every address is normalized with viem `getAddress` and rejected if zero.
 * Side-effects: none
 * Links: src/app/api/v1/nodes/[id]/payment-prereqs/route.ts, https://cognidao.org/knowledge/node-formation-contract
 * @public
 */

import {
  extractDaoConfig,
  extractOperatorWalletConfig,
  parseRepoSpec,
} from "@cogni/repo-spec";
import { type Address, getAddress, zeroAddress } from "viem";

import type { NodeStatus } from "@/shared/db/nodes";
import { CHAINS } from "@/shared/web3";

/** The Base mainnet chain id the DAO must be on (payments settle on Base). */
const PAYMENT_PREREQS_CHAIN_ID = String(CHAINS.BASE.chainId);

const DEFAULT_REPO_SPEC_PATH = ".cogni/repo-spec.yaml";

interface NodeSpecLocationInput {
  readonly slug: string;
  readonly repoOwner: string;
  readonly repoName: string;
  readonly repoSpecPath: string | null;
}

interface NodeSpecLocation {
  readonly owner: string;
  readonly repo: string;
  readonly path: string;
}

/**
 * Where the node's repo-spec lives. A row with a projected `repoSpecPath` (catalog reconcile)
 * names its own `repoOwner`/`repoName`/`repoSpecPath`. A wizard-born row has `repoSpecPath = null`
 * AND `repoOwner`/`repoName` pointing at the PARENT monorepo (the submodule-pin target), so reading
 * them would read the operator's own spec: fall back to the env-scoped mint owner + slug + the
 * default path, the same node repo `activate-payments` writes to.
 */
export function resolveNodeSpecLocation(
  node: NodeSpecLocationInput,
  mintOwner: string | undefined
): NodeSpecLocation | null {
  if (node.repoSpecPath) {
    return {
      owner: node.repoOwner,
      repo: node.repoName,
      path: node.repoSpecPath,
    };
  }
  if (!mintOwner) return null;
  return {
    owner: mintOwner,
    repo: node.slug,
    path: DEFAULT_REPO_SPEC_PATH,
  };
}

export interface PaymentPrereqAddresses {
  readonly operatorWalletAddress: Address;
  readonly daoAddress: Address;
  readonly pluginAddress: Address;
  readonly signalAddress: Address;
}

type PaymentPrereqEvaluation =
  | { readonly ok: true; readonly addresses: PaymentPrereqAddresses }
  | {
      readonly ok: false;
      readonly kind: "spec_invalid";
    }
  | {
      readonly ok: false;
      readonly kind: "missing";
      readonly missingKey: string;
    }
  | {
      readonly ok: false;
      readonly kind: "invalid";
      readonly invalidKey: string;
      readonly reason: "invalid_address" | "zero_address" | "unsupported_chain";
    };

function normalize(
  value: string,
  key: string
):
  | { readonly ok: true; readonly address: Address }
  | Extract<PaymentPrereqEvaluation, { kind: "invalid" }> {
  let address: Address;
  try {
    address = getAddress(value);
  } catch {
    return {
      ok: false,
      kind: "invalid",
      invalidKey: key,
      reason: "invalid_address",
    };
  }
  if (address === zeroAddress) {
    return {
      ok: false,
      kind: "invalid",
      invalidKey: key,
      reason: "zero_address",
    };
  }
  return { ok: true, address };
}

/** Validate the repo-spec text: wallet declared, DAO block complete on Base, addresses sane. */
export function evaluatePaymentPrereqs(
  specText: string
): PaymentPrereqEvaluation {
  let spec: ReturnType<typeof parseRepoSpec>;
  try {
    spec = parseRepoSpec(specText);
  } catch {
    return { ok: false, kind: "spec_invalid" };
  }

  const walletRaw = extractOperatorWalletConfig(spec)?.address;
  if (!walletRaw) {
    return {
      ok: false,
      kind: "missing",
      missingKey: "operator_wallet.address",
    };
  }

  const governance = spec.governance;
  const dao = extractDaoConfig(spec);
  if (!dao) {
    const missingKey = !governance?.dao_contract
      ? "governance.dao_contract"
      : !governance.plugin_contract
        ? "governance.plugin_contract"
        : !governance.signal_contract
          ? "governance.signal_contract"
          : "governance.chain_id";
    return { ok: false, kind: "missing", missingKey };
  }
  if (dao.chain_id !== PAYMENT_PREREQS_CHAIN_ID) {
    return {
      ok: false,
      kind: "invalid",
      invalidKey: "governance.chain_id",
      reason: "unsupported_chain",
    };
  }

  const wallet = normalize(walletRaw, "operator_wallet.address");
  if (!wallet.ok) return wallet;
  const daoAddress = normalize(dao.dao_contract, "governance.dao_contract");
  if (!daoAddress.ok) return daoAddress;
  const plugin = normalize(dao.plugin_contract, "governance.plugin_contract");
  if (!plugin.ok) return plugin;
  const signal = normalize(dao.signal_contract, "governance.signal_contract");
  if (!signal.ok) return signal;

  return {
    ok: true,
    addresses: {
      operatorWalletAddress: wallet.address,
      daoAddress: daoAddress.address,
      pluginAddress: plugin.address,
      signalAddress: signal.address,
    },
  };
}

interface PaymentPrereqRow {
  readonly status: string;
  readonly operatorWalletAddress: string | null;
  readonly daoAddress: string | null;
  readonly pluginAddress: string | null;
  readonly signalAddress: string | null;
  /** Set once the payment Split is deployed; it was built from the recorded wallet. */
  readonly splitAddress?: string | null;
}

/** What the route should do with the row, given its status (decided BEFORE any git read). */
type PrereqStatusGate =
  | { readonly action: "read" }
  | { readonly action: "no_change" }
  | { readonly action: "invalid_state" };

export function gatePrereqStatus(status: string): PrereqStatusGate {
  switch (status as NodeStatus) {
    case "published":
    case "wallet_ready":
      return { action: "read" };
    case "payments_ready":
    case "active":
      return { action: "no_change" };
    default:
      return { action: "invalid_state" };
  }
}

type PrereqRecordPlan =
  | {
      readonly kind: "mismatch";
      readonly mismatchedKeys: readonly (keyof PaymentPrereqAddresses)[];
    }
  /** `published`: record all four addresses and advance to `wallet_ready`. */
  | { readonly kind: "record_and_advance" }
  /** `wallet_ready`: row already matches git on every non-null column and none is null. */
  | { readonly kind: "unchanged" }
  /** `wallet_ready`: record the null columns only; the status does not change. */
  | {
      readonly kind: "record_null_columns";
      readonly columns: Partial<PaymentPrereqAddresses>;
    };

const ADDRESS_KEYS = [
  "operatorWalletAddress",
  "daoAddress",
  "pluginAddress",
  "signalAddress",
] as const;

/** Decide the write for a `published` / `wallet_ready` row. Pure; never overwrites a differing value. */
export function planPrereqRecord(
  row: PaymentPrereqRow,
  git: PaymentPrereqAddresses
): PrereqRecordPlan {
  const mismatchedKeys: (keyof PaymentPrereqAddresses)[] = ADDRESS_KEYS.filter(
    (key) => {
      const current = row[key];
      return (
        current != null && current.toLowerCase() !== git[key].toLowerCase()
      );
    }
  );
  // A deployed Split was built from the recorded wallet: filling a NULL wallet column now would
  // let the repo-spec silently define a different one. Refuse; never back-fill under a Split.
  if (row.splitAddress != null && row.operatorWalletAddress == null) {
    mismatchedKeys.push("operatorWalletAddress");
  }
  if (mismatchedKeys.length > 0) return { kind: "mismatch", mismatchedKeys };

  if (row.status === "published") return { kind: "record_and_advance" };

  const columns: Partial<Record<(typeof ADDRESS_KEYS)[number], Address>> = {};
  for (const key of ADDRESS_KEYS) {
    if (row[key] == null) columns[key] = git[key];
  }
  if (Object.keys(columns).length === 0) return { kind: "unchanged" };
  return { kind: "record_null_columns", columns };
}
