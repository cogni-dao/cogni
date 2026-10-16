// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@shared/secrets/database-ca-command`
 * Purpose: Install the canonical public database CA before the declared process starts.
 * Scope: Pure command construction; preserves every original argument as a positional value.
 * Invariants: No caller text is shell code; Node loads trust before any database client imports.
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

export function withDatabaseCaTrust(
  command: readonly string[],
  args: readonly string[] = []
): { command: string[]; args: string[] } {
  if (!command.length || !command[0]) {
    throw new Error("database CA startup requires a declared process command");
  }
  return {
    command: ["/bin/sh", "-ec", installTrust, "cogni-database-trust"],
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
  return withDatabaseCaTrust(command, input.args);
}
