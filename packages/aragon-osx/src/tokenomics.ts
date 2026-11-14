// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/aragon-osx/tokenomics`
 * Purpose: Typed DAO ownership token templates for Aragon OSx formation.
 * Scope: Pure policy math only; does not perform wallet, chain, or persistence IO.
 * Invariants:
 * - TOKENOMICS_POLICY_SUPPLY_IS_NOT_GENESIS_FLOAT: templates distinguish long-run policy supply from tokens minted at DAO creation.
 * - TOKENOMICS_GENESIS_MINT_IS_CONCRETE: current formation mints only to explicit receiver addresses.
 * - TOKENOMICS_FUTURE_SUPPLY_IS_NOT_ONCHAIN: future supply is policy math until a distributor/emissions holder is deployed.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-formation-contract
 * @public
 */

import {
  DAO_TOKEN_SUPPLY_DEFAULT_WHOLE,
  DAO_TOKEN_SUPPLY_MAX_WHOLE,
  DAO_TOKEN_SUPPLY_MIN_WHOLE,
} from "./osx/version";

export const BPS_DENOMINATOR = 10_000;

export type DaoTokenomicsTemplateId =
  | "solo_one_token"
  | "solo_20_percent"
  | "council_three_equal"
  | "open_contributor_pool";

export type DaoTokenAllocationRole =
  | "genesis_steward"
  | "founding_council"
  | "future_supply_unissued";

export interface DaoTokenomicsTemplate {
  readonly id: DaoTokenomicsTemplateId;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly ownerShape: {
    readonly kind: "fixed" | "variable";
    readonly defaultCount: number;
    readonly minCount: number;
    readonly maxCount: number | null;
  };
  readonly genesisMint:
    | {
        readonly kind: "fixedPerFounder";
        readonly wholeTokensPerFounder: number;
      }
    | {
        readonly kind: "percentOfPolicySupply";
        readonly bps: number;
      };
  readonly futureAllocationBps: readonly {
    readonly role: DaoTokenAllocationRole;
    readonly label: string;
    readonly bps: number;
  }[];
  readonly enabledInWizard: boolean;
}

export interface ResolvedDaoTokenomics {
  readonly templateId: DaoTokenomicsTemplateId;
  readonly ownerCount: number;
  readonly policySupplyWholeTokens: number;
  readonly genesisMintWholeTokens: number;
  readonly futureSupplyNotMintedWholeTokens: number;
  readonly slices: readonly {
    readonly role: DaoTokenAllocationRole;
    readonly label: string;
    readonly wholeTokens: number;
    readonly bps: number;
    readonly mintedAtFormation: boolean;
  }[];
}

export const DAO_TOKENOMICS_TEMPLATES = [
  {
    id: "solo_one_token",
    label: "Single owner, one-token start",
    shortLabel: "1 owner · 1 token",
    description:
      "Mint one governance token to the connected wallet; model future supply for later DAO-controlled emissions.",
    ownerShape: {
      kind: "fixed",
      defaultCount: 1,
      minCount: 1,
      maxCount: 1,
    },
    genesisMint: {
      kind: "fixedPerFounder",
      wholeTokensPerFounder: 1,
    },
    futureAllocationBps: [
      {
        role: "future_supply_unissued",
        label: "Future supply, not minted",
        bps: 10_000,
      },
    ],
    enabledInWizard: true,
  },
  {
    id: "solo_20_percent",
    label: "Single owner, 20% bootstrap",
    shortLabel: "1 owner · 20%",
    description:
      "Mint an explicit founder float now while modeling future supply for later DAO-controlled emissions.",
    ownerShape: {
      kind: "fixed",
      defaultCount: 1,
      minCount: 1,
      maxCount: 1,
    },
    genesisMint: {
      kind: "percentOfPolicySupply",
      bps: 2_000,
    },
    futureAllocationBps: [
      {
        role: "future_supply_unissued",
        label: "Future supply, not minted",
        bps: 10_000,
      },
    ],
    enabledInWizard: true,
  },
  {
    id: "council_three_equal",
    label: "Three-owner founding council",
    shortLabel: "3 owners · equal",
    description:
      "Three founding wallets each receive one governance token; future supply is left unissued for later DAO-controlled emissions.",
    ownerShape: {
      kind: "fixed",
      defaultCount: 3,
      minCount: 3,
      maxCount: 3,
    },
    genesisMint: {
      kind: "fixedPerFounder",
      wholeTokensPerFounder: 1,
    },
    futureAllocationBps: [
      {
        role: "future_supply_unissued",
        label: "Future supply, not minted",
        bps: 10_000,
      },
    ],
    enabledInWizard: false,
  },
  {
    id: "open_contributor_pool",
    label: "N-owner contributor pool",
    shortLabel: "N owners · 10%",
    description:
      "Mint a small initial contributor float across N wallets; leave the majority unissued for later earned claims.",
    ownerShape: {
      kind: "variable",
      defaultCount: 5,
      minCount: 2,
      maxCount: null,
    },
    genesisMint: {
      kind: "percentOfPolicySupply",
      bps: 1_000,
    },
    futureAllocationBps: [
      {
        role: "future_supply_unissued",
        label: "Future supply, not minted",
        bps: 10_000,
      },
    ],
    enabledInWizard: false,
  },
] as const satisfies readonly DaoTokenomicsTemplate[];

export const DEFAULT_DAO_TOKENOMICS_TEMPLATE_ID: DaoTokenomicsTemplateId =
  "solo_one_token";

export function getDaoTokenomicsTemplate(
  templateId: DaoTokenomicsTemplateId
): DaoTokenomicsTemplate {
  const template = DAO_TOKENOMICS_TEMPLATES.find((t) => t.id === templateId);
  if (!template) {
    throw new RangeError(`Unknown DAO tokenomics template: ${templateId}`);
  }
  return template;
}

export function resolveDaoTokenomics(params: {
  readonly templateId: DaoTokenomicsTemplateId;
  readonly policySupplyWholeTokens: number;
  readonly ownerCount?: number;
}): ResolvedDaoTokenomics {
  const template = getDaoTokenomicsTemplate(params.templateId);
  const policySupply = params.policySupplyWholeTokens;
  if (!Number.isSafeInteger(policySupply)) {
    throw new RangeError("DAO policy supply must be a safe whole number");
  }
  if (
    policySupply < DAO_TOKEN_SUPPLY_MIN_WHOLE ||
    policySupply > DAO_TOKEN_SUPPLY_MAX_WHOLE
  ) {
    throw new RangeError(
      `DAO policy supply must be between ${DAO_TOKEN_SUPPLY_MIN_WHOLE} and ${DAO_TOKEN_SUPPLY_MAX_WHOLE} whole tokens`
    );
  }

  const ownerCount = params.ownerCount ?? template.ownerShape.defaultCount;
  validateOwnerCount(template, ownerCount);

  const genesisMintWholeTokens =
    template.genesisMint.kind === "fixedPerFounder"
      ? template.genesisMint.wholeTokensPerFounder * ownerCount
      : Math.floor((policySupply * template.genesisMint.bps) / BPS_DENOMINATOR);

  if (genesisMintWholeTokens <= 0) {
    throw new RangeError("Genesis mint must be positive");
  }
  if (genesisMintWholeTokens > policySupply) {
    throw new RangeError("Genesis mint cannot exceed policy supply");
  }

  const genesisBps = Math.round(
    (genesisMintWholeTokens / policySupply) * BPS_DENOMINATOR
  );
  const futureSupplyNotMintedWholeTokens =
    policySupply - genesisMintWholeTokens;
  const configuredFutureBps = template.futureAllocationBps.reduce(
    (sum, slice) => sum + slice.bps,
    0
  );

  const futureSlices = template.futureAllocationBps.map((slice, index) => {
    const isLast = index === template.futureAllocationBps.length - 1;
    const allocatedBefore = template.futureAllocationBps
      .slice(0, index)
      .reduce(
        (sum, previous) =>
          sum +
          Math.floor(
            (futureSupplyNotMintedWholeTokens * previous.bps) /
              configuredFutureBps
          ),
        0
      );
    const wholeTokens = isLast
      ? futureSupplyNotMintedWholeTokens - allocatedBefore
      : Math.floor(
          (futureSupplyNotMintedWholeTokens * slice.bps) / configuredFutureBps
        );

    return {
      role: slice.role,
      label: slice.label,
      wholeTokens,
      bps:
        policySupply > 0
          ? Math.round((wholeTokens / policySupply) * BPS_DENOMINATOR)
          : 0,
      mintedAtFormation: false,
    };
  });

  return {
    templateId: template.id,
    ownerCount,
    policySupplyWholeTokens: policySupply,
    genesisMintWholeTokens,
    futureSupplyNotMintedWholeTokens,
    slices: [
      {
        role:
          ownerCount === 1 ? "genesis_steward" : ("founding_council" as const),
        label: ownerCount === 1 ? "Genesis steward" : "Founding council",
        wholeTokens: genesisMintWholeTokens,
        bps: genesisBps,
        mintedAtFormation: true,
      },
      ...futureSlices,
    ],
  };
}

function validateOwnerCount(
  template: DaoTokenomicsTemplate,
  ownerCount: number
): void {
  if (!Number.isSafeInteger(ownerCount)) {
    throw new RangeError("ownerCount must be a safe whole number");
  }
  if (ownerCount < template.ownerShape.minCount) {
    throw new RangeError(
      `ownerCount must be at least ${template.ownerShape.minCount}`
    );
  }
  if (
    template.ownerShape.maxCount != null &&
    ownerCount > template.ownerShape.maxCount
  ) {
    throw new RangeError(
      `ownerCount must be at most ${template.ownerShape.maxCount}`
    );
  }
}

export function defaultDaoPolicySupplyWholeTokens(): number {
  return DAO_TOKEN_SUPPLY_DEFAULT_WHOLE;
}
