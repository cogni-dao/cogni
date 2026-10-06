// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/adapters/operator-change-recovery-http`
 * Purpose: HTTP delegation from the scheduler-worker to the operator-owned recovery plane.
 * Scope: Calls one operator-internal route. Does not hold or use GitHub credentials or database credentials.
 * Invariants:
 *   - Bearer SCHEDULER_API_TOKEN authenticates the internal hop and is never logged.
 *   - The stable business Idempotency-Key is supplied by the Activity unchanged.
 *   - Exact HTTP 200 with a valid strict result is semantic completion.
 *   - 408, 429, 5xx, network, and ambiguous 200 responses remain retryable.
 * Side-effects: HTTP I/O to the operator node only
 * Links: task.5188, packages/node-contracts/src/operator-change-recovery.internal.v1.contract.ts
 * @internal
 */

import {
  type OperatorChangeRecoveryRequest,
  type OperatorChangeRecoveryResult,
  OperatorChangeRecoveryResultSchema,
} from "@cogni/node-contracts";
import type { Logger } from "../observability/logger.js";
import {
  type OperatorChangeRecoveryHttpClient,
  RunHttpClientError,
} from "../ports/index.js";

export interface OperatorChangeRecoveryHttpAdapterDeps {
  nodeEndpoints: Map<string, string>;
  schedulerApiToken: string;
  logger: Logger;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function readErrorText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable>";
  }
}

export function createOperatorChangeRecoveryHttpClient(
  deps: OperatorChangeRecoveryHttpAdapterDeps
): OperatorChangeRecoveryHttpClient {
  const { nodeEndpoints, schedulerApiToken, logger } = deps;

  function operatorBase(): string {
    const url = nodeEndpoints.get("operator");
    if (!url) {
      throw new RunHttpClientError(
        'Operator-change recovery requires an "operator" entry in COGNI_NODE_ENDPOINTS',
        0,
        false
      );
    }
    return url.replace(/\/$/, "");
  }

  return {
    async recover(
      input: OperatorChangeRecoveryRequest,
      idempotencyKey: string
    ): Promise<OperatorChangeRecoveryResult> {
      const url = `${operatorBase()}/api/internal/operator-change/recover`;
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${schedulerApiToken}`,
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(input),
        });
      } catch (error) {
        throw new RunHttpClientError(
          `POST ${url} network failure: ${error instanceof Error ? error.message : String(error)}`,
          0,
          true
        );
      }

      if (response.status !== 200) {
        const errorText = await readErrorText(response);
        const retryable = isRetryableStatus(response.status);
        logger.error(
          {
            url,
            status: response.status,
            retryable,
            owner: input.owner,
            repo: input.repo,
            losingHeadSha: input.losingHeadSha,
          },
          "operator-change recovery delegation failed"
        );
        throw new RunHttpClientError(
          `POST ${url} -> ${response.status}: ${errorText}`,
          response.status,
          retryable
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new RunHttpClientError(
          `POST ${url} returned an ambiguous invalid JSON response: ${error instanceof Error ? error.message : String(error)}`,
          200,
          true
        );
      }
      const parsed = OperatorChangeRecoveryResultSchema.safeParse(body);
      if (!parsed.success) {
        throw new RunHttpClientError(
          `POST ${url} returned an ambiguous invalid recovery result`,
          200,
          true
        );
      }
      return parsed.data;
    },
  };
}
