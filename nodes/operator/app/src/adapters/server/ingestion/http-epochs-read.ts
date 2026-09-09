// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ingestion/http-epochs-read`
 * Purpose: HTTP READ of a FOREIGN owning node's ledger epochs from the operator gateway
 *   (`GET {nodeUrl}/api/internal/attribution/epochs`). The read twin of
 *   `http-receipt-delivery` — mirrors its shape exactly (placement-resolved nodeUrl, Bearer
 *   SCHEDULER_API_TOKEN, retryable-vs-permanent status classification, structured error logging).
 * Scope: HTTP read client for FOREIGN (remote) owning nodes; does not touch a DB. The operator's
 *   own-node epochs read stays a local store read in the gateway route (OPERATOR_AGGREGATES_ARE_DERIVED:
 *   the operator holds no cross-node DB creds, so it derives foreign aggregates over the node's
 *   internal HTTP API).
 * Invariants:
 *   - NO_DB_IN_READ: only fetch(); the owning node reads its OWN ledger.
 *   - NODE_RESOLUTION_IS_A_DB_READ: the base URL comes from the operator's OWN registry via the
 *     injected `NodeAddressPort`, never a static endpoint map (the map was removed from the app).
 *   - PLACEMENT_DECIDES_THE_ADDRESS (bug.5106): the address is a function of the node's DECLARED
 *     placement — in-cluster Service DNS for a k3s node, the public host for one placed on
 *     decentralized compute. Hardcoding the in-cluster convention here made every foreign-node
 *     epoch read 502 for an off-cluster node.
 *   - Bearer SCHEDULER_API_TOKEN attached to every request (MVP dispatch identity, same as receipt
 *     delivery + graph dispatch; the per-node principal is the hardening — task.5033).
 *   - 4xx (except transient 404/408/409/429) → permanent; 5xx/network → retryable. Throws on non-2xx.
 *   - Output validated against the frozen contract before returning.
 * Side-effects: IO (HTTP)
 * Links: packages/node-contracts/src/attribution.epochs.internal.v1.contract.ts,
 *   nodes/operator/app/src/adapters/server/ingestion/http-receipt-delivery.ts,
 *   nodes/operator/app/src/ports/epochs-read.port.ts, bug.5008
 * @internal
 */

import {
  type InternalListEpochsOutput,
  internalListEpochsOperation,
} from "@cogni/node-contracts";
import {
  type EpochsRead,
  EpochsReadError,
  type NodeAddressPort,
} from "@/ports";
import type { Logger } from "@/shared/observability";

export interface HttpEpochsReadDeps {
  /** Bearer token for the internal dispatch identity (SCHEDULER_API_TOKEN). */
  readonly schedulerApiToken: string;
  /** Placement-aware address resolution — the write twin uses the same seam. */
  readonly nodeAddress: NodeAddressPort;
  readonly logger: Logger;
}

/**
 * HTTP status codes that are retryable — mirrors http-receipt-delivery.ts: transient 404 (deploy-time
 * race before the node-app has the epochs route), 408/429 (transient), 409 (in-progress). Everything
 * else in the 4xx range (400/401/403/422) is a structural failure and stays non-retryable.
 * 5xx/network → retryable.
 */
const RETRYABLE_TRANSIENT_4XX = new Set([404, 408, 409, 429]);
function isRetryableStatus(status: number): boolean {
  if (status >= 500) return true;
  return RETRYABLE_TRANSIENT_4XX.has(status);
}

function authHeaders(token: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function readErrorText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable>";
  }
}

export function createHttpEpochsRead(deps: HttpEpochsReadDeps): EpochsRead {
  const { schedulerApiToken, nodeAddress, logger } = deps;

  return {
    async listEpochsForForeignNode(
      slug,
      page
    ): Promise<InternalListEpochsOutput> {
      // PLACEMENT_DECIDES_THE_ADDRESS — the node's declared placement resolves the base URL
      // (in-cluster Service DNS, or the public host when the node runs off-cluster).
      const base = await nodeAddress.resolveNodeAppBaseUrl(slug);
      const query = new URLSearchParams({
        slug,
        limit: String(page.limit),
        offset: String(page.offset),
      });
      const url = `${base}/api/internal/attribution/epochs?${query}`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: authHeaders(schedulerApiToken),
        });
      } catch (err) {
        // Network / DNS failure — retryable (the node-app may just be mid-roll).
        logger.error(
          {
            event: "attribution.epochs_read_failed",
            slug,
            url,
            err: String(err),
            retryable: true,
          },
          "attribution epochs read failed (network)"
        );
        throw new EpochsReadError(
          `GET ${url} network error: ${String(err)}`,
          0,
          true
        );
      }

      if (!response.ok) {
        const errorText = await readErrorText(response);
        const retryable = isRetryableStatus(response.status);
        logger.error(
          {
            event: "attribution.epochs_read_failed",
            slug,
            url,
            status: response.status,
            errorText,
            retryable,
          },
          "attribution epochs read failed"
        );
        throw new EpochsReadError(
          `GET ${url} -> ${response.status}: ${errorText}`,
          response.status,
          retryable
        );
      }

      const body = await response.json();
      // Validate the node's response against the frozen contract before handing it back — a shape
      // drift surfaces here (permanent) rather than as a malformed gateway response.
      return internalListEpochsOperation.output.parse(body);
    },
  };
}
