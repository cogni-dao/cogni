// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { reliabilityStatusV1Schema } from "@cogni/node-contracts";

import type { ReliabilityStatusReaderPort } from "@/ports";

export class HttpReliabilityStatusAdapter
  implements ReliabilityStatusReaderPort
{
  constructor(
    private readonly config: {
      readonly baseUrl: string;
      readonly bearerToken: string;
      readonly timeoutMs?: number;
    }
  ) {}

  async read(
    input: Parameters<ReliabilityStatusReaderPort["read"]>[0]
  ): Promise<Awaited<ReturnType<ReliabilityStatusReaderPort["read"]>>> {
    const url = new URL("/v1/status", this.config.baseUrl);
    url.searchParams.set("node_id", input.nodeId);
    url.searchParams.set("node_slug", input.nodeSlug);
    url.searchParams.set("environment", input.environment);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${this.config.bearerToken}` },
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 5_000),
    });
    if (!response.ok) {
      throw new Error(`reliability actuator status failed: ${response.status}`);
    }
    return reliabilityStatusV1Schema.parse(await response.json());
  }
}
