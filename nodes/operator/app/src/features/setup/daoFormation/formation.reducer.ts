// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/setup/daoFormation/formation.reducer`
 * Purpose: Pure reducer and types for DAO formation state machine.
 * Scope: State transitions only; does not perform IO or side effects.
 * Invariants: Single source of truth for formation state.
 * Side-effects: none
 * Links: docs/spec/node-formation.md, work/projects/proj.chain-deployment-refactor.md
 * @public
 */

import type {
  DaoTokenomicsTemplateId,
  Hex,
  HexAddress,
} from "@cogni/aragon-osx";

export type TxHash = Hex;

// ============================================================================
// Types
// ============================================================================

export interface DAOFormationConfig {
  tokenName: string;
  tokenSymbol: string;
  tokenomicsTemplateId: DaoTokenomicsTemplateId;
  policySupplyUnits: bigint;
  genesisMintUnits: bigint;
  initialHolder: HexAddress;
}

export interface VerifiedAddresses {
  dao: HexAddress;
  token: HexAddress;
  plugin: HexAddress;
  signal: HexAddress;
}

export type FormationPhase =
  | "IDLE"
  | "PREFLIGHT"
  | "CREATING_DAO"
  | "AWAITING_DAO_CONFIRMATION"
  | "DEPLOYING_SIGNAL"
  | "AWAITING_SIGNAL_CONFIRMATION"
  | "VERIFYING"
  | "SUCCESS"
  | "ERROR";

export interface FormationState {
  phase: FormationPhase;
  config: DAOFormationConfig | null;
  daoTxHash: TxHash | null;
  signalTxHash: TxHash | null;
  signalBlockNumber: number | null;
  daoAddress: HexAddress | null;
  pluginAddress: HexAddress | null;
  addresses: VerifiedAddresses | null;
  errorMessage: string | null;
  /** True if user can retry from current state */
  recoverable: boolean;
}

// ============================================================================
// Actions
// ============================================================================

export type FormationAction =
  | { type: "START_PREFLIGHT"; config: DAOFormationConfig }
  | { type: "PREFLIGHT_PASSED" }
  | { type: "PREFLIGHT_FAILED"; error: string }
  | { type: "DAO_TX_SENT"; txHash: TxHash }
  | {
      type: "DAO_TX_CONFIRMED";
      daoAddress: HexAddress;
      pluginAddress: HexAddress;
    }
  | { type: "DAO_TX_FAILED"; error: string }
  | { type: "SIGNAL_TX_SENT"; txHash: TxHash }
  | { type: "SIGNAL_TX_CONFIRMED"; blockNumber: number }
  | { type: "SIGNAL_TX_FAILED"; error: string }
  | {
      type: "VERIFY_SUCCESS";
      addresses: VerifiedAddresses;
    }
  | { type: "VERIFY_FAILED"; errors: string[] }
  | { type: "RESET" };

// ============================================================================
// Initial State
// ============================================================================

export const initialFormationState: FormationState = {
  phase: "IDLE",
  config: null,
  daoTxHash: null,
  signalTxHash: null,
  signalBlockNumber: null,
  daoAddress: null,
  pluginAddress: null,
  addresses: null,
  errorMessage: null,
  recoverable: false,
};

// ============================================================================
// Reducer
// ============================================================================

export function formationReducer(
  state: FormationState,
  action: FormationAction
): FormationState {
  switch (action.type) {
    case "START_PREFLIGHT":
      return {
        ...initialFormationState,
        phase: "PREFLIGHT",
        config: action.config,
      };

    case "PREFLIGHT_PASSED":
      return { ...state, phase: "CREATING_DAO" };

    case "PREFLIGHT_FAILED":
      return {
        ...state,
        phase: "ERROR",
        errorMessage: action.error,
        recoverable: true,
      };

    case "DAO_TX_SENT":
      return {
        ...state,
        phase: "AWAITING_DAO_CONFIRMATION",
        daoTxHash: action.txHash,
      };

    case "DAO_TX_CONFIRMED":
      return {
        ...state,
        phase: "DEPLOYING_SIGNAL",
        daoAddress: action.daoAddress,
        pluginAddress: action.pluginAddress,
      };

    case "DAO_TX_FAILED":
      return {
        ...state,
        phase: "ERROR",
        errorMessage: action.error,
        recoverable: true,
      };

    case "SIGNAL_TX_SENT":
      return {
        ...state,
        phase: "AWAITING_SIGNAL_CONFIRMATION",
        signalTxHash: action.txHash,
      };

    case "SIGNAL_TX_CONFIRMED":
      return {
        ...state,
        phase: "VERIFYING",
        signalBlockNumber: action.blockNumber,
      };

    case "SIGNAL_TX_FAILED":
      // DAO already created, manual recovery needed
      return {
        ...state,
        phase: "ERROR",
        errorMessage: action.error,
        recoverable: false,
      };

    case "VERIFY_SUCCESS":
      return {
        ...state,
        phase: "SUCCESS",
        addresses: action.addresses,
      };

    case "VERIFY_FAILED":
      return {
        ...state,
        phase: "ERROR",
        errorMessage: action.errors.join("; "),
        recoverable: false,
      };

    case "RESET":
      return initialFormationState;

    default:
      return state;
  }
}
