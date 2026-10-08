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
import { makeLogger } from "@/shared/observability";

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

// `component` is the Loki label the whole fleet already queries for this
// adapter — bug.5358 was diagnosed on poly through
// `component="doltgres-work-items"`. Binding the same value here is what makes
// operator's work-item behaviour visible to the same dashboards and queries.
const workItemsLogger = makeLogger({ component: "doltgres-work-items" });

export function getDoltgresWorkItemsAdapter(): DoltgresWorkItemAdapter {
  if (!_adapter)
    _adapter = new DoltgresWorkItemAdapter(getDoltgresSql(), {
      idFloor: OPERATOR_ID_FLOOR,
      logger: workItemsLogger,
      // RECONNECT_AFTER_DESTROYED_CONNECTION: a query that hits the deadline
      // destroys its reserved connection. Without a way to rebuild the client
      // the adapter stays latched on a dead pool — the 2026-10-03 poly incident
      // (bug.5358). The factory is the same one the singleton was built from.
      recreateClient: createSql,
    });
  return _adapter;
}
