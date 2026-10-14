// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
import { defineConfig } from "drizzle-kit";

// Administrative postgres only. This schema is excluded from all app migrators.
export default defineConfig({
  schema: "./packages/db-schema/infra-control.ts",
  out: "./infra/compose/runtime/postgres-init/control-migrations",
  dialect: "postgresql",
  dbCredentials: { url: "postgresql://generate@localhost:0/postgres" },
  verbose: true,
  strict: true,
});
