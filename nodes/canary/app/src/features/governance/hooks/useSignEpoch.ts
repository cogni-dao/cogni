// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/hooks/useSignEpoch`
 * Purpose: Orchestrates EIP-712 epoch signing flow — fetch sign-data, wallet signature, POST finalize.
 * Scope: Client-side state machine for sign & finalize. Does not access database or server-side logic.
 * Invariants: WRITE_ROUTES_APPROVER_GATED (server enforces), SIGNATURE_SCOPE_BOUND (sign-data includes all scope fields).
 * Side-effects: IO (HTTP fetch, wagmi wallet signing)
 * Links: src/contracts/attribution.sign-data.v1.contract.ts, src/contracts/attribution.finalize-epoch.v1.contract.ts
 * @public
 */

"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useReducer } from "react";
import { useSignTypedData } from "wagmi";

// Types mirrored from contracts (features must_not_import contracts layer)

/** EIP-712 typed data returned by the sign-data endpoint. */
interface SignDataResponse {
  readonly domain: { name: string; version: string; chainId: number };
  readonly types: {
    AttributionStatement: readonly { name: string; type: string }[];
  };
  readonly primaryType: "AttributionStatement";
  readonly message: {
    nodeId: string;
    scopeId: string;
    epochId: string;
    finalAllocationSetHash: string;
    poolTotalCredits: string;
  };
}

/** Response from the finalize endpoint. */
interface FinalizeResponse {
  readonly workflowId: string;
}

// ── State machine ────────────────────────────────────────────────────────────

export type SignEpochPhase =
  | "IDLE"
  | "FETCHING_DATA"
  | "AWAITING_SIGNATURE"
  | "SUBMITTING"
  | "SUCCESS"
  | "ERROR";

export interface SignEpochState {
  readonly phase: SignEpochPhase;
  readonly isInFlight: boolean;
  readonly workflowId: string | null;
  readonly errorMessage: string | null;
}

type InternalState =
  | { phase: "IDLE" }
  | { phase: "FETCHING_DATA" }
  | { phase: "AWAITING_SIGNATURE" }
  | { phase: "SUBMITTING" }
  | { phase: "SUCCESS"; workflowId: string }
  | { phase: "ERROR"; message: string };

type Action =
  | { type: "START_FETCH" }
  | { type: "DATA_FETCHED" }
  | { type: "SIGNATURE_RECEIVED" }
  | { type: "FINALIZE_SUCCESS"; workflowId: string }
  | { type: "FAIL"; message: string }
  | { type: "RESET" };

function reducer(state: InternalState, action: Action): InternalState {
  switch (action.type) {
    case "START_FETCH":
      return { phase: "FETCHING_DATA" };
    case "DATA_FETCHED":
      return { phase: "AWAITING_SIGNATURE" };
    case "SIGNATURE_RECEIVED":
      return { phase: "SUBMITTING" };
    case "FINALIZE_SUCCESS":
      return { phase: "SUCCESS", workflowId: action.workflowId };
    case "FAIL":
      return { phase: "ERROR", message: action.message };
    case "RESET":
      return { phase: "IDLE" };
    default:
      return state;
  }
}

function derivePublicState(internal: InternalState): SignEpochState {
  const isInFlight =
    internal.phase === "FETCHING_DATA" ||
    internal.phase === "AWAITING_SIGNATURE" ||
    internal.phase === "SUBMITTING";

  switch (internal.phase) {
    case "IDLE":
    case "FETCHING_DATA":
    case "AWAITING_SIGNATURE":
    case "SUBMITTING":
      return {
        phase: internal.phase,
        isInFlight,
        workflowId: null,
        errorMessage: null,
      };
    case "SUCCESS":
      return {
        phase: "SUCCESS",
        isInFlight: false,
        workflowId: internal.workflowId,
        errorMessage: null,
      };
    case "ERROR":
      return {
        phase: "ERROR",
        isInFlight: false,
        workflowId: null,
        errorMessage: internal.message,
      };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchSignData(epochId: string): Promise<SignDataResponse> {
  const res = await fetch(`/api/v1/attribution/epochs/${epochId}/sign-data`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json() as Promise<SignDataResponse>;
}

async function postFinalize(
  epochId: string,
  signature: string
): Promise<FinalizeResponse> {
  const res = await fetch(`/api/v1/attribution/epochs/${epochId}/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ signature }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json() as Promise<FinalizeResponse>;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface UseSignEpochReturn {
  state: SignEpochState;
  sign: () => Promise<void>;
  reset: () => void;
}

export function useSignEpoch(epochId: string): UseSignEpochReturn {
  const [internal, dispatch] = useReducer(reducer, { phase: "IDLE" });
  const { signTypedDataAsync } = useSignTypedData();
  const queryClient = useQueryClient();

  const sign = useCallback(async () => {
    if (internal.phase !== "IDLE") return;

    try {
      // 1. Fetch EIP-712 typed data from server
      dispatch({ type: "START_FETCH" });
      const typedData = await fetchSignData(epochId);

      // 2. Request wallet signature
      dispatch({ type: "DATA_FETCHED" });
      const signature = await signTypedDataAsync({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      });

      // 3. POST signature to finalize endpoint
      dispatch({ type: "SIGNATURE_RECEIVED" });
      const result = await postFinalize(epochId, signature);

      dispatch({ type: "FINALIZE_SUCCESS", workflowId: result.workflowId });
      void queryClient.invalidateQueries({ queryKey: ["governance"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Signing failed";
      dispatch({ type: "FAIL", message });
    }
  }, [internal.phase, epochId, signTypedDataAsync, queryClient]);

  const reset = useCallback(() => {
    dispatch({ type: "RESET" });
  }, []);

  return {
    state: derivePublicState(internal),
    sign,
    reset,
  };
}
