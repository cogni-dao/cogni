// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Validate the dedicated controller's app-role DSN without ever echoing secret input. */

const FORBIDDEN_DATABASE_USERS = new Set([
  "postgres",
  "root",
  "admin",
  "superuser",
  "app_service",
]);

export function assertComputeCostAppRoleDatabaseUrl(databaseUrl: string): void {
  let databaseUser: string;
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("unsupported protocol");
    }
    databaseUser = decodeURIComponent(parsed.username);
  } catch {
    // Node's ERR_INVALID_URL carries the full DSN in `input`; never propagate it or a cause.
    throw new Error("compute cost ledger DATABASE_URL is invalid");
  }

  const normalizedDatabaseUser = databaseUser.toLowerCase();
  if (
    !databaseUser ||
    FORBIDDEN_DATABASE_USERS.has(normalizedDatabaseUser) ||
    normalizedDatabaseUser.startsWith("service_")
  ) {
    throw new Error(
      "compute cost ledger requires a non-superuser app-role DATABASE_URL"
    );
  }
}
