// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-sync-service/adapters/fake-dolt-remote`
 * Purpose: CI/test DoltRemotePort — records push calls in-memory, no IO.
 * Scope: Deterministic fake for unit tests + CI isolation (no Doltgres, no network).
 * Invariants: Honors the same contract — push() throws DoltRemotePortError when `failWith` is set.
 * Side-effects: none
 * Links: docs/guides/create-service.md (CI isolation via fake adapters)
 * @public
 */

import {
  type DoltPushResult,
  type DoltRemotePort,
  DoltRemotePortError,
} from "../ports/dolt-remote.port.js";

export interface FakeDoltRemoteOptions {
  node?: string;
  remote?: string;
  branch?: string;
  /** When set, every push() rejects with a DoltRemotePortError wrapping this. */
  failWith?: unknown;
}

export class FakeDoltRemoteAdapter implements DoltRemotePort {
  readonly kind = "fake";
  pushCount = 0;
  closed = false;
  readonly signals: Array<AbortSignal | undefined> = [];
  private readonly opts: Required<Omit<FakeDoltRemoteOptions, "failWith">> &
    Pick<FakeDoltRemoteOptions, "failWith">;

  constructor(options: FakeDoltRemoteOptions = {}) {
    this.opts = {
      node: options.node ?? "operator",
      remote:
        options.remote ??
        "https://doltremoteapi.dolthub.com/cogni-dao/knowledge-operator",
      branch: options.branch ?? "main",
      failWith: options.failWith,
    };
  }

  async push(signal?: AbortSignal): Promise<DoltPushResult> {
    this.pushCount += 1;
    this.signals.push(signal);
    if (this.opts.failWith !== undefined) {
      throw new DoltRemotePortError(
        "fake push failure",
        this.opts.node,
        this.opts.failWith
      );
    }
    return {
      node: this.opts.node,
      remote: this.opts.remote,
      branch: this.opts.branch,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
