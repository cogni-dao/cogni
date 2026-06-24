// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/compute/cherry-compute.adapter`
 * Purpose: Cherry Servers HTTP client implementing the READ half of ComputeResourcePort —
 *   maps a Cherry team's account credit to the provider-agnostic ComputeBalance.
 * Scope: Implements `balances()` via GET /v1/teams. Handles bearer auth, timeout, error mapping.
 *   Does NOT provision/release VMs or settle payment (those are the funding-gated write half).
 * Invariants:
 *   - PROVIDER_AGNOSTIC: Cherry's `credit.account` shape is converted here and never escapes;
 *     callers see only ComputeBalance.
 *   - ADAPTER_SWAPPABLE: implements the provider-blind ComputeResourcePort; AkashComputeAdapter
 *     is a 1:1 replacement.
 *   - FAIL_LOUD: HTTP / network / timeout failures throw CherryComputeError so the scheduled
 *     emitter can observe its own failure (a silently-dead balance monitor is the bug we fix).
 * Side-effects: IO (HTTPS requests to api.cherryservers.com)
 * Links: ComputeResourcePort (@cogni/ai-tools/capabilities/compute), infra/provision/cherry/CHERRY_REFERENCE.md
 * @internal
 */

import type { ComputeBalance, ComputeResourcePort } from "@cogni/ai-tools";

const PROVIDER = "cherry";

export interface CherryComputeAdapterConfig {
  /** Cherry Servers API token (Bearer). Same value as the provisioning CHERRY_AUTH_TOKEN. */
  authToken: string;
  /** Request timeout in milliseconds. */
  timeoutMs: number;
  /** API base URL; defaults to the public Cherry v1 API. */
  baseUrl?: string;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Shape of one team's credit as returned by GET /v1/teams (only the fields we map). */
interface CherryTeam {
  id?: number | string;
  credit?: {
    account?: {
      remaining?: number | string;
      currency?: string;
    };
  };
}

/**
 * Cherry Servers compute adapter — READ half of ComputeResourcePort.
 */
export class CherryComputeAdapter implements ComputeResourcePort {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: CherryComputeAdapterConfig) {
    this.baseUrl = (
      config.baseUrl ?? "https://api.cherryservers.com/v1"
    ).replace(/\/$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async balances(): Promise<readonly ComputeBalance[]> {
    const teams = await this.fetchTeams();
    const asOf = new Date().toISOString();

    return teams
      .filter((team) => team.credit?.account?.remaining !== undefined)
      .map((team) => {
        const account = team.credit?.account;
        return {
          provider: PROVIDER,
          accountId: String(team.id ?? "unknown"),
          currency: account?.currency ?? "USD",
          remaining: Number(account?.remaining ?? 0),
          asOf,
          // No usage history in a single read → runway is unknown for v0.
          estimatedDaysRemaining: null,
        } satisfies ComputeBalance;
      });
  }

  private async fetchTeams(): Promise<CherryTeam[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs
    );

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/teams`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.authToken}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new CherryComputeError(
          "HTTP_ERROR",
          `Cherry /teams failed: ${response.status} ${response.statusText}`
        );
      }

      const json = (await response.json()) as unknown;
      if (!Array.isArray(json)) {
        throw new CherryComputeError(
          "UNEXPECTED_SHAPE",
          "Cherry /teams did not return an array"
        );
      }
      return json as CherryTeam[];
    } catch (error) {
      if (error instanceof CherryComputeError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new CherryComputeError(
          "TIMEOUT",
          `Cherry /teams timeout after ${this.config.timeoutMs}ms`
        );
      }
      throw new CherryComputeError(
        "NETWORK_ERROR",
        error instanceof Error ? error.message : "unknown error"
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export type CherryComputeErrorCode =
  | "HTTP_ERROR"
  | "UNEXPECTED_SHAPE"
  | "TIMEOUT"
  | "NETWORK_ERROR";

/** Stable error codes for the Cherry balance read path. */
export class CherryComputeError extends Error {
  constructor(
    public readonly code: CherryComputeErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CherryComputeError";
  }
}
