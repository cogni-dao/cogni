// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/db/doltgres/client`
 * Purpose: Lazy operator-Doltgres `Sql` singleton + adapter wiring for the work_items API.
 * Scope: Builds a postgres.js client and a `DoltgresWorkItemAdapter`. Mirrors `drizzle.client.ts` shape.
 * Invariants: Single connection per process; lazy initialization; throws `DoltgresNotConfiguredError` when `DOLTGRES_URL` is unset.
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
  });
}

export function getDoltgresSql(): Sql {
  if (!_sql) _sql = createSql();
  return _sql;
}

export function getDoltgresWorkItemsAdapter(): DoltgresWorkItemAdapter {
  if (!_adapter)
    _adapter = new DoltgresWorkItemAdapter(getDoltgresSql(), {
      idFloor: OPERATOR_ID_FLOOR,
    });
  return _adapter;
}
