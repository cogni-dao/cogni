// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/setup/hooks/useAragonPreflight`
 * Purpose: Validate Aragon OSx contract deployment before DAO creation.
 * Scope: Client-side preflight checks (getCode + PSP invariant); does not initiate transactions or modify state.
 * Invariants: Must verify DAOFactory, PSP, and TokenVotingRepo have deployed code.
 * Side-effects: IO (RPC reads via wagmi)
 * Links: https://cognidao.org/knowledge/node-formation-contract
 * @public
 */

"use client";

import { getAragonAddresses, type SupportedChainId } from "@cogni/aragon-osx";
import { DAO_FACTORY_ABI } from "@cogni/node-shared";
import { useCallback, useState } from "react";
import { usePublicClient } from "wagmi";

export type PreflightStatus =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready" }
  | { status: "error"; message: string };

export interface UseAragonPreflightReturn {
  preflightStatus: PreflightStatus;
  runPreflight: (chainId: SupportedChainId) => Promise<boolean>;
  reset: () => void;
}

export function useAragonPreflight(): UseAragonPreflightReturn {
  const [preflightStatus, setPreflightStatus] = useState<PreflightStatus>({
    status: "idle",
  });
  const publicClient = usePublicClient();

  const runPreflight = useCallback(
    async (chainId: SupportedChainId): Promise<boolean> => {
      if (!publicClient) {
        setPreflightStatus({
          status: "error",
          message: "Wallet not connected",
        });
        return false;
      }

      setPreflightStatus({ status: "checking" });

      try {
        const addresses = getAragonAddresses(chainId);

        // 1. Check DAOFactory has code
        const factoryCode = await publicClient.getCode({
          address: addresses.daoFactory as `0x${string}`,
        });
        if (!factoryCode || factoryCode === "0x") {
          setPreflightStatus({
            status: "error",
            message: `DAOFactory not deployed at ${addresses.daoFactory}`,
          });
          return false;
        }

        // 2. Check PSP has code
        const pspCode = await publicClient.getCode({
          address: addresses.pluginSetupProcessor as `0x${string}`,
        });
        if (!pspCode || pspCode === "0x") {
          setPreflightStatus({
            status: "error",
            message: `PluginSetupProcessor not deployed at ${addresses.pluginSetupProcessor}`,
          });
          return false;
        }

        // 3. Check TokenVotingRepo has code
        const repoCode = await publicClient.getCode({
          address: addresses.tokenVotingPluginRepo as `0x${string}`,
        });
        if (!repoCode || repoCode === "0x") {
          setPreflightStatus({
            status: "error",
            message: `TokenVotingRepo not deployed at ${addresses.tokenVotingPluginRepo}`,
          });
          return false;
        }

        // 4. Verify factory → PSP invariant
        const factoryPsp = await publicClient.readContract({
          address: addresses.daoFactory as `0x${string}`,
          abi: DAO_FACTORY_ABI,
          functionName: "pluginSetupProcessor",
        });

        if (
          factoryPsp.toLowerCase() !==
          addresses.pluginSetupProcessor.toLowerCase()
        ) {
          setPreflightStatus({
            status: "error",
            message: `DAOFactory.pluginSetupProcessor() mismatch: expected ${addresses.pluginSetupProcessor}, got ${factoryPsp}`,
          });
          return false;
        }

        setPreflightStatus({ status: "ready" });
        return true;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Preflight check failed";
        setPreflightStatus({ status: "error", message });
        return false;
      }
    },
    [publicClient]
  );

  const reset = useCallback(() => {
    setPreflightStatus({ status: "idle" });
  }, []);

  return {
    preflightStatus,
    runPreflight,
    reset,
  };
}
