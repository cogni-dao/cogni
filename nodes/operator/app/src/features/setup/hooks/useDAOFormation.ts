// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/setup/hooks/useDAOFormation`
 * Purpose: Thin wiring layer for DAO formation state machine.
 * Scope: Connects wagmi hooks to pure reducer; does not contain business logic.
 * Invariants: Reducer is single source of truth; effects only for receipt transitions.
 * Side-effects: IO (wagmi, server API); React state
 * Links: docs/spec/node-formation.md, work/projects/proj.chain-deployment-refactor.md
 * @public
 */

"use client";

import {
  decodeDaoCreationReceipt,
  ReceiptDecodingError,
  SUPPORTED_CHAIN_IDS,
  type SupportedChainId,
} from "@cogni/aragon-osx";
import {
  COGNI_SIGNAL_ABI,
  COGNI_SIGNAL_BYTECODE,
} from "@cogni/cogni-contracts";
import { DAO_FACTORY_ABI } from "@cogni/node-shared";
import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  useAccount,
  useChainId,
  useDeployContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { verifyFormation } from "../daoFormation/api";
import {
  type DAOFormationConfig,
  type FormationState,
  formationReducer,
  initialFormationState,
} from "../daoFormation/formation.reducer";
import {
  buildCreateDaoArgs,
  buildDeploySignalArgs,
} from "../daoFormation/txBuilders";

// Re-export types for convenience
export type {
  DAOFormationConfig,
  FormationState,
  VerifiedAddresses,
} from "../daoFormation/formation.reducer";

// ============================================================================
// Hook
// ============================================================================

export interface UseDAOFormationReturn {
  state: FormationState;
  startFormation: (config: DAOFormationConfig) => void;
  reset: () => void;
  isSupported: boolean;
}

export function useDAOFormation(): UseDAOFormationReturn {
  const [state, dispatch] = useReducer(formationReducer, initialFormationState);

  const chainId = useChainId();
  const { address: walletAddress } = useAccount();

  // Wagmi: DAO creation
  const {
    writeContract: writeCreateDao,
    data: daoTxHash,
    error: daoWriteError,
    reset: resetDaoWrite,
  } = useWriteContract();

  const { data: daoReceipt, error: daoReceiptError } =
    useWaitForTransactionReceipt({
      hash: daoTxHash,
    });

  // Wagmi: CogniSignal deployment
  const {
    deployContract,
    data: signalTxHash,
    error: signalDeployError,
    reset: resetSignalDeploy,
  } = useDeployContract();

  const { data: signalReceipt, error: signalReceiptError } =
    useWaitForTransactionReceipt({
      hash: signalTxHash,
    });

  // Attempt tracking to guard stale async
  const attemptIdRef = useRef(0);

  const isSupported = (SUPPORTED_CHAIN_IDS as readonly number[]).includes(
    chainId
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Effect: DAO tx hash received
  // ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (daoTxHash && state.phase === "CREATING_DAO") {
      dispatch({ type: "DAO_TX_SENT", txHash: daoTxHash });
    }
  }, [daoTxHash, state.phase]);

  // ──────────────────────────────────────────────────────────────────────────
  // Effect: DAO tx confirmed → decode receipt
  // ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (daoReceipt && state.phase === "AWAITING_DAO_CONFIRMATION") {
      try {
        const { daoAddress, pluginAddress } =
          decodeDaoCreationReceipt(daoReceipt);
        dispatch({ type: "DAO_TX_CONFIRMED", daoAddress, pluginAddress });
      } catch (err) {
        const message =
          err instanceof ReceiptDecodingError
            ? err.message
            : "Failed to decode DAO creation receipt";
        dispatch({ type: "DAO_TX_FAILED", error: message });
      }
    }
  }, [daoReceipt, state.phase]);

  // ──────────────────────────────────────────────────────────────────────────
  // Effect: DAO tx errors
  // ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (daoWriteError && state.phase === "CREATING_DAO") {
      dispatch({
        type: "DAO_TX_FAILED",
        error: daoWriteError.message || "DAO creation failed",
      });
    }
  }, [daoWriteError, state.phase]);

  useEffect(() => {
    if (daoReceiptError && state.phase === "AWAITING_DAO_CONFIRMATION") {
      dispatch({
        type: "DAO_TX_FAILED",
        error: daoReceiptError.message || "DAO transaction failed",
      });
    }
  }, [daoReceiptError, state.phase]);

  // ──────────────────────────────────────────────────────────────────────────
  // Effect: Auto-deploy signal when DAO confirmed
  // ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (
      state.phase === "DEPLOYING_SIGNAL" &&
      state.daoAddress &&
      !signalTxHash
    ) {
      const { args } = buildDeploySignalArgs(state.daoAddress);
      deployContract({
        abi: COGNI_SIGNAL_ABI,
        bytecode: COGNI_SIGNAL_BYTECODE,
        args,
      });
    }
  }, [state.phase, state.daoAddress, signalTxHash, deployContract]);

  // ──────────────────────────────────────────────────────────────────────────
  // Effect: Signal tx hash received
  // ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (signalTxHash && state.phase === "DEPLOYING_SIGNAL") {
      dispatch({ type: "SIGNAL_TX_SENT", txHash: signalTxHash });
    }
  }, [signalTxHash, state.phase]);

  // ──────────────────────────────────────────────────────────────────────────
  // Effect: Signal tx confirmed
  // ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (signalReceipt && state.phase === "AWAITING_SIGNAL_CONFIRMATION") {
      dispatch({
        type: "SIGNAL_TX_CONFIRMED",
        blockNumber: Number(signalReceipt.blockNumber),
      });
    }
  }, [signalReceipt, state.phase]);

  // ──────────────────────────────────────────────────────────────────────────
  // Effect: Signal tx errors
  // ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (signalDeployError && state.phase === "DEPLOYING_SIGNAL") {
      dispatch({
        type: "SIGNAL_TX_FAILED",
        error: signalDeployError.message || "Signal deployment failed",
      });
    }
  }, [signalDeployError, state.phase]);

  useEffect(() => {
    if (signalReceiptError && state.phase === "AWAITING_SIGNAL_CONFIRMATION") {
      dispatch({
        type: "SIGNAL_TX_FAILED",
        error: signalReceiptError.message || "Signal transaction failed",
      });
    }
  }, [signalReceiptError, state.phase]);

  // ──────────────────────────────────────────────────────────────────────────
  // Effect: Auto-verify when signal confirmed
  // ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const { phase, daoTxHash, signalTxHash, signalBlockNumber, config } = state;

    if (
      phase !== "VERIFYING" ||
      !daoTxHash ||
      !signalTxHash ||
      !signalBlockNumber ||
      !config
    ) {
      return;
    }

    const currentAttempt = attemptIdRef.current;

    (async () => {
      const result = await verifyFormation({
        chainId,
        daoTxHash,
        signalTxHash,
        signalBlockNumber,
        initialHolder: config.initialHolder,
        expectedTokenSupplyUnits: config.tokenSupplyUnits,
      });

      if (attemptIdRef.current !== currentAttempt) return;

      if (result.ok) {
        dispatch({
          type: "VERIFY_SUCCESS",
          addresses: result.addresses,
        });
      } else {
        dispatch({ type: "VERIFY_FAILED", errors: result.errors });
      }
    })();
  }, [state, chainId]);

  // ──────────────────────────────────────────────────────────────────────────
  // startFormation
  // ──────────────────────────────────────────────────────────────────────────
  const startFormation = useCallback(
    (config: DAOFormationConfig) => {
      if (!isSupported) {
        dispatch({
          type: "PREFLIGHT_FAILED",
          error: `Chain ${chainId} not supported. Use Base, Base Sepolia, or Sepolia.`,
        });
        return;
      }

      if (!walletAddress) {
        dispatch({ type: "PREFLIGHT_FAILED", error: "Wallet not connected" });
        return;
      }

      attemptIdRef.current += 1;
      dispatch({ type: "START_PREFLIGHT", config });

      // Skip preflight for now (useAragonPreflight can be integrated later)
      dispatch({ type: "PREFLIGHT_PASSED" });

      // Build and send createDao tx
      const txArgs = buildCreateDaoArgs(chainId as SupportedChainId, config);

      writeCreateDao({
        address: txArgs.address as `0x${string}`,
        abi: DAO_FACTORY_ABI,
        functionName: "createDao",
        args: txArgs.args,
      });
    },
    [chainId, walletAddress, isSupported, writeCreateDao]
  );

  // ──────────────────────────────────────────────────────────────────────────
  // reset
  // ──────────────────────────────────────────────────────────────────────────
  const reset = useCallback(() => {
    attemptIdRef.current += 1;
    resetDaoWrite();
    resetSignalDeploy();
    dispatch({ type: "RESET" });
  }, [resetDaoWrite, resetSignalDeploy]);

  return {
    state,
    startFormation,
    reset,
    isSupported,
  };
}
