// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Bounded HTTP transport for one operator-signed node action. */

import type { NodeActionHttpPort } from "@/ports";

const NODE_ACTION_TIMEOUT_MS = 15_000;
const MAX_NODE_ACTION_RESPONSE_BYTES = 1_048_576;

export class HttpNodeActionAdapter implements NodeActionHttpPort {
  async post(input: {
    readonly url: string;
    readonly assertion: string;
    readonly body: string;
  }) {
    const response = await fetch(input.url, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(NODE_ACTION_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${input.assertion}`,
        "content-type": "application/json",
      },
      body: input.body,
    });
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_NODE_ACTION_RESPONSE_BYTES) {
      throw new Error("node action response exceeds 1 MiB");
    }
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body,
    };
  }
}
