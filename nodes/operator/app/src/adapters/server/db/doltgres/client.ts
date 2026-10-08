// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/db/doltgres/client`
 * Purpose: Lazy operator-Doltgres `Sql` singleton + adapter wiring for the work_items API.
 * Scope: Builds a postgres.js client and a `DoltgresWorkItemAdapter`. Mirrors `drizzle.client.ts` shape.
 * Invariants: One serialized connection per process (`max: 1`); lazy initialization; throws `DoltgresNotConfiguredError` when `DOLTGRES_URL` is unset.
 *   OPERATOR_KEEPS_THE_5000_FLOOR: operator's store holds its imported pre-API
 *   markdown corpus below 5000, so its allocator must clear it. Nodes booting an
 *   empty store take the package default and start at 1.
 * Side-effects: IO (database connection on first access).
 * Links: docs/spec/work-items-port.md, docs/guides/agent-api-validation.md
 * @internal
 */

import { buildDoltgresClient } from "@cogni/knowledge-store/adapters/doltgres";
import {
  DoltgresWorkItemAdapter,
  OPERATOR_ID_FLOOR,
} from "@cogni/work-items/adapters/doltgres";
import type { Sql } from "postgres";

import { serverEnv } from "@/shared/env";
import type { Logger } from "@/shared/observability";

export class DoltgresNotConfiguredError extends Error {
  constructor() {
    super(
      "Doltgres is not configured for this runtime. Set DOLTGRES_URL to enable the operator work-items API."
    );
    this.name = "DoltgresNotConfiguredError";
  }
}

let _sql: Sql | null = null;
let _adapter: DoltgresWorkItemAdapter | null = null;

function createSql(): Sql {
  const env = serverEnv();
  if (!env.DOLTGRES_URL) {
    throw new DoltgresNotConfiguredError();
  }
  return buildDoltgresClient({
    connectionString: env.DOLTGRES_URL,
    applicationName: `cogni_work_items_${env.SERVICE_NAME ?? "app"}`,
    // SERIALIZED_WORK_ITEM_POOL: the shared adapter admits one operation at a
    // time behind its own FIFO queue and a cross-process advisory lock, so a
    // pool wider than 1 only adds connections that contend for that lock. This
    // also matches node-template's wiring, which is the reference.
    max: 1,
  });
}

export function getDoltgresSql(): Sql {
  if (!_sql) _sql = createSql();
  return _sql;
}

// NODE_IDENTITY_IS_THE_APP'S, NOT THIS MODULE'S. Work items are node-sovereign:
// this adapter only ever touches the emitting node's own `knowledge_<slug>`
// store, and no node serves another node's items. So this module must not
// resolve a node id — the caller passes the app logger, which already carries
// the emitter identity (`svcNode`, from `makeLogger({ nodeId })` in
// bootstrap/container.ts), and `component` is child-bound here so the fleet's
// existing `component="doltgres-work-items"` queries keep working. That is also
// exactly how node-template wires it.
//
// An earlier version of this file minted its own logger and called `getNodeId()`
// to stamp each line. It produced attributable lines, but by the wrong
// mechanism: it duplicated node-identity resolution inside a data-access module
// — the shape left over from when the operator brokered work items for the
// fleet — and it re-bound the mutable `nodeId` field that
// `observability/server/logger.ts` warns about, the one call sites override to a
// TARGET node and which then leaks an operator line into that node's per-node
// log view.
export function getDoltgresWorkItemsAdapter(
  logger?: Logger
): DoltgresWorkItemAdapter {
  if (!_adapter)
    _adapter = new DoltgresWorkItemAdapter(getDoltgresSql(), {
      idFloor: OPERATOR_ID_FLOOR,
      // Conditional spread, not `logger?.child(...)`: `exactOptionalPropertyTypes`
      // rejects an explicit `undefined` for an optional property.
      ...(logger
        ? { logger: logger.child({ component: "doltgres-work-items" }) }
        : {}),
      // RECONNECT_AFTER_DESTROYED_CONNECTION: a query that hits the deadline
      // destroys its reserved connection. Without a way to rebuild the client
      // the adapter stays latched on a dead pool — the 2026-10-03 poly incident
      // (bug.5358). The factory is the same one the singleton was built from.
      recreateClient: createSql,
    });
  return _adapter;
}
