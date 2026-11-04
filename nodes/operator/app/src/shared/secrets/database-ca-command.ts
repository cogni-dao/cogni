// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@shared/secrets/database-ca-command`
 * Purpose: Install the canonical public database CA before the declared process starts, and (for a
 *   node app given its migration DSN) migrate the node's own databases before it serves (task.5408).
 * Scope: Pure command construction; preserves every original argument as a positional value.
 * Invariants: No caller text is shell code; Node loads trust before any database client imports.
 *   GREEN_MIGRATES_ITSELF (task.5408): a `cogni-node-app-v1` app whose env carries
 *   DATABASE_MIGRATION_URL runs the image's own migrators (Postgres, then Doltgres when DOLTGRES_URL
 *   is set) with the CA trust above, unsets the migration DSN, then execs the app. Any migrator exit
 *   other than 0 stops the container before the app starts, so the release never proves and blue keeps
 *   serving. This is the legacy k3s `migrate` initContainer (infra/k8s/base/node-app/deployment.yaml),
 *   folded into the one Akash container.
 * Side-effects: none (the resulting command writes an owner-only temporary CA at runtime).
 * Links: docs/spec/secrets-management.md, features/compute/node-services-workload-spec.ts
 * @internal
 */

const installTrust = [
  "set -eu",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal runtime shell expansion
  'if [ -n "${DATABASE_SSL_CA_CERT:-}" ]; then',
  "  umask 077",
  "  cogni_db_ca_file=$(mktemp /tmp/cogni-database-ca.XXXXXX)",
  '  printf "%s\\n" "$DATABASE_SSL_CA_CERT" > "$cogni_db_ca_file"',
  '  export NODE_EXTRA_CA_CERTS="$cogni_db_ca_file"',
  '  export PGSSLROOTCERT="$cogni_db_ca_file"',
  "fi",
  'exec "$@"',
].join("\n");

/**
 * The node app image's bundled migrators (node-template Dockerfile runner stage): drizzle Postgres
 * migrator and the Doltgres migrator + verifier. Both read DATABASE_URL and require NODE_NAME.
 */
const NODE_APP_MIGRATIONS = [
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal runtime shell expansion
  ': "${NODE_NAME:?NODE_NAME is required to migrate}"',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal runtime shell expansion
  ': "${DATABASE_MIGRATION_URL:?DATABASE_MIGRATION_URL is required to migrate}"',
  'DATABASE_URL="$DATABASE_MIGRATION_URL" node /app/app/migrate.mjs /app/app/migrations',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal runtime shell expansion
  'if [ -n "${DOLTGRES_URL:-}" ]; then',
  '  DATABASE_URL="$DOLTGRES_URL" node /app/app/migrate-doltgres.mjs /app/app/doltgres-migrations',
  "fi",
  "unset DATABASE_MIGRATION_URL",
];

function trustScript(migrate: boolean): string {
  if (!migrate) return installTrust;
  const lines = installTrust.split("\n");
  const exec = lines.pop();
  return [...lines, ...NODE_APP_MIGRATIONS, exec].join("\n");
}

export function withDatabaseCaTrust(
  command: readonly string[],
  args: readonly string[] = [],
  options: { migrateNodeApp?: boolean } = {}
): { command: string[]; args: string[] } {
  if (!command.length || !command[0]) {
    throw new Error("database CA startup requires a declared process command");
  }
  return {
    command: [
      "/bin/sh",
      "-ec",
      trustScript(options.migrateNodeApp === true),
      "cogni-database-trust",
    ],
    args: [...command, ...args],
  };
}

export function databaseConsumerCommand(input: {
  runtimeProfile?: string;
  command?: readonly string[];
  args?: readonly string[];
  secretRefs: readonly { key: string }[];
}): { command?: readonly string[]; args?: readonly string[] } {
  const consumesDatabase = input.secretRefs.some((ref) =>
    ["DATABASE_URL", "DATABASE_SERVICE_URL", "DATABASE_MIGRATION_URL"].includes(
      ref.key
    )
  );
  if (!consumesDatabase) {
    return {
      ...(input.command ? { command: input.command } : {}),
      ...(input.args ? { args: input.args } : {}),
    };
  }
  const command =
    input.command ??
    (input.runtimeProfile === "cogni-node-app-v1"
      ? ["node", "app/server.js"]
      : undefined);
  if (!command)
    throw new Error("database-consuming image requires a declared command");
  // GREEN_MIGRATES_ITSELF: only the node app profile, and only when its env carries the migration DSN.
  const migrateNodeApp =
    input.runtimeProfile === "cogni-node-app-v1" &&
    input.secretRefs.some((ref) => ref.key === "DATABASE_MIGRATION_URL");
  return withDatabaseCaTrust(command, input.args, { migrateNodeApp });
}
