// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Infrastructure boundaries for operator-authorized, node-executed actions. */

import type { NodeActionClaims } from "@cogni/node-contracts";

export interface NodeActionSignerPort {
  sign(claims: NodeActionClaims): Promise<string>;
}

export interface NodeActionHttpResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: Uint8Array;
}

export interface NodeActionHttpPort {
  post(input: {
    readonly url: string;
    readonly assertion: string;
    /** Exact UTF-8 JSON text covered by the assertion's bodyHash. */
    readonly body: string;
  }): Promise<NodeActionHttpResponse>;
}
