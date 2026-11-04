// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/bindings`
 * Purpose: THE ONE function that derives a consumer's connection env from a state workload's live
 *   lease: `DATABASE_URL=postgres://postgres:<pw>@<host>:<forwardedPort>/postgres?sslmode=require`
 *   (task.5400, design CD2 BIND_BY_CREDENTIAL).
 * Scope: Pure. Host and port come from the state lease's endpoints (the actuator reports forwarded
 *   ports as `tcp://host:port`); the password comes from the secret the sequencer owns. No IP allowlist.
 * Invariants:
 *   - BINDING_DERIVED_NOT_STORED: callers re-derive from the live lease on every consumer attempt,
 *     so a moved or re-forwarded port is picked up with no stored copy to go stale.
 *   - OWN_STATE_MIGRATES_ITSELF: a `DATABASE_URL` binding also yields `DATABASE_MIGRATION_URL` for the SAME
 *     state lease, so the start wrapper migrates the node's own database (task.5408).
 *   - ONE_TCP_ENDPOINT: a state lease must expose exactly one forwarded tcp endpoint; zero or several
 *     is a refusal, never a guess.
 * Side-effects: none
 * @internal
 */

export interface StateBindingInput {
  readonly name: string;
  readonly endpoints: readonly string[];
  readonly password: string;
}

export interface ResolvedBinding {
  readonly env: string;
  readonly value: string;
  readonly host: string;
  readonly port: number;
}

const TCP_ENDPOINT = /^tcp:\/\/([a-zA-Z0-9.-]+):(\d{1,5})$/;

/** Parse the single forwarded tcp endpoint of a state lease. Throws on zero or several. */
export function forwardedTcpEndpoint(endpoints: readonly string[]): {
  host: string;
  port: number;
} {
  const matches = endpoints
    .map((e) => TCP_ENDPOINT.exec(e))
    .filter((m): m is RegExpExecArray => m !== null);
  if (matches.length !== 1) {
    throw new Error(
      `binding: expected exactly one forwarded tcp endpoint, found ${matches.length} in ${JSON.stringify(endpoints)}`
    );
  }
  const m = matches[0] as RegExpExecArray;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`binding: forwarded port out of range: ${m[2]}`);
  return { host: m[1] as string, port };
}

/**
 * Resolve every binding of `consumer` that targets `state` into env entries.
 * Bindings that target another workload are ignored here (the caller resolves each state once).
 */
export function resolveBinding(
  consumer: {
    readonly bindings: readonly {
      readonly env: string;
      readonly workload: string;
    }[];
  },
  state: StateBindingInput
): readonly ResolvedBinding[] {
  const targeted = consumer.bindings.filter((b) => b.workload === state.name);
  if (targeted.length === 0) return [];
  const { host, port } = forwardedTcpEndpoint(state.endpoints);
  const url = `postgres://postgres:${encodeURIComponent(state.password)}@${host}:${port}/postgres?sslmode=require`;
  return targeted.flatMap((b) =>
    b.env === "DATABASE_URL"
      ? [
          { env: b.env, value: url, host, port },
          // OWN_STATE_MIGRATES_ITSELF (task.5408): a node whose database is its own state lease migrates
          // that database, with the same derived DSN, before it serves. The shared bucket's migration
          // DSN names another database and is never sent here.
          { env: "DATABASE_MIGRATION_URL", value: url, host, port },
        ]
      : [{ env: b.env, value: url, host, port }]
  );
}
