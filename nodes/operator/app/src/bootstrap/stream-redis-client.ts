// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Node-owned stream client. Deep readiness reports connection failure. */
import Redis from "ioredis";

export function createStreamRedisClient(url: string): Redis {
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
  // Prevent ioredis from printing arbitrary native error stacks.
  client.on("error", () => {});
  return client;
}
