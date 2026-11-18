// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/adapters/instance-directory`
 * Purpose: Resolve a NON-MAIN instance of a node (`canary`, later `pr-<n>`) to its host through the
 *   operator-served instance directory `GET /api/v1/deploy/instances?nodeId=&env=` (story.5159 step 1,
 *   design hub `candidate-pr-lanes`). A run carries an instance NAME; this is the only place a name becomes
 *   a URL, so `SCHEDULER_API_TOKEN` never goes to a host the run named, and a canary run calls back to the
 *   canary copy (node-template bug.0050).
 * Scope: HTTP read + per-node cache. It resolves only non-main instances; `main` stays on
 *   COGNI_NODE_ENDPOINTS in the callers and never reaches this module.
 * Invariants:
 *   - NEVER_FALL_BACK_TO_MAIN: an instance that is unknown, closed or unresolvable throws
 *     `InstanceUnresolvedError`; no caller sends a request, so no token leaves the worker.
 *   - ABSENT_IS_FINAL: an instance the directory did not list is refused (non-retryable). A cached or
 *     last-good answer never turns an absent instance into a host.
 *   - LAST_GOOD_ONLY_WHEN_UNREACHABLE: the last successful response is used only when the operator cannot
 *     be reached (network error, timeout, 5xx, 408, 429, 404) and only for an instance that response
 *     listed. Any other operator answer (401, 403, 400, 409, a malformed body) is final, never masked.
 *   - BOUNDED_CACHE: an answer is reused for `ttlMs` (60 s). A miss re-reads the directory unless it was
 *     read less than `missRefreshMs` ago, so a freshly proven instance is found within seconds while an
 *     unknown name cannot make the worker hammer the operator.
 *   - HOST_IS_A_BARE_HOSTNAME: a directory host that is not a plain DNS hostname is dropped as absent.
 *   - READ_ONLY_CREDENTIAL: the bearer is the directory credential (`OPERATOR_DIRECTORY_TOKEN`), never
 *     `SCHEDULER_API_TOKEN`.
 * Side-effects: IO (HTTP to the operator)
 * Links: nodes/operator/app/src/contracts/deploy.instances.v1.contract.ts, ../ports/index.ts
 * @internal
 */

import { z } from "zod";

import type { Logger } from "../observability/logger.js";
import {
  InstanceUnresolvedError,
  type InstanceUrlResolver,
} from "../ports/index.js";

/** How long a directory answer is reused. */
export const DIRECTORY_TTL_MS = 60_000;
/** A miss re-reads the directory unless the cached answer is younger than this. */
export const DIRECTORY_MISS_REFRESH_MS = 5_000;
const DIRECTORY_TIMEOUT_MS = 5_000;

const INSTANCE_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DEPLOY_ENVS = ["candidate-a", "preview", "production"] as const;
export type DirectoryEnv = (typeof DEPLOY_ENVS)[number];

/** The env a Temporal namespace serves (`cogni-candidate-a` -> `candidate-a`), or undefined. */
export function deployEnvOfNamespace(
  namespace: string
): DirectoryEnv | undefined {
  const env = namespace.replace(/^cogni-/, "");
  return (DEPLOY_ENVS as readonly string[]).includes(env)
    ? (env as DirectoryEnv)
    : undefined;
}

const DirectoryResponseSchema = z.object({
  env: z.enum(DEPLOY_ENVS),
  instances: z.array(
    z.object({ instance: z.string(), host: z.string() }).passthrough()
  ),
});

export interface InstanceDirectoryOptions {
  /** Operator base URL, no trailing path (`OPERATOR_DIRECTORY_URL`). */
  readonly baseUrl: string;
  /** The directory read credential (`OPERATOR_DIRECTORY_TOKEN`). Never logged. */
  readonly token: string;
  /** The env this worker's namespace serves. */
  readonly env: DirectoryEnv;
  readonly logger: Logger;
  readonly ttlMs?: number;
  readonly missRefreshMs?: number;
  readonly timeoutMs?: number;
  /** Test seams. */
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
}

interface Snapshot {
  readonly fetchedAt: number;
  readonly hosts: ReadonlyMap<string, string>;
}

/** The operator could not answer: the one case the last-good copy may serve. */
class DirectoryUnreachable extends Error {}

const UNREACHABLE_STATUSES = new Set([404, 408, 429]);

export function createInstanceDirectory(
  options: InstanceDirectoryOptions
): InstanceUrlResolver {
  const {
    baseUrl,
    token,
    env,
    logger,
    ttlMs = DIRECTORY_TTL_MS,
    missRefreshMs = DIRECTORY_MISS_REFRESH_MS,
    timeoutMs = DIRECTORY_TIMEOUT_MS,
    now = Date.now,
    fetchImpl = fetch,
  } = options;
  const base = baseUrl.replace(/\/+$/, "");
  /** The last successful response per node: the fresh cache and the last-good copy are the same object. */
  const snapshots = new Map<string, Snapshot>();
  const inflight = new Map<string, Promise<Snapshot>>();

  const refuse = (nodeId: string, instance: string, why: string) =>
    new InstanceUnresolvedError(
      `Instance "${instance}" of node "${nodeId}" is ${why}; no request was sent`,
      false
    );

  async function readDirectory(nodeId: string): Promise<Snapshot> {
    const url = `${base}/api/v1/deploy/instances?nodeId=${encodeURIComponent(nodeId)}&env=${env}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new DirectoryUnreachable(
        `instance directory unreachable: ${(err as Error).message}`
      );
    }
    if (response.status >= 500 || UNREACHABLE_STATUSES.has(response.status))
      throw new DirectoryUnreachable(
        `instance directory answered ${response.status}`
      );
    if (!response.ok)
      throw new InstanceUnresolvedError(
        `Instance directory refused the read for node "${nodeId}": ${response.status}`,
        false
      );
    let parsed: z.infer<typeof DirectoryResponseSchema>;
    try {
      parsed = DirectoryResponseSchema.parse(await response.json());
    } catch {
      throw new InstanceUnresolvedError(
        `Instance directory answered a malformed body for node "${nodeId}"`,
        false
      );
    }
    if (parsed.env !== env)
      throw new InstanceUnresolvedError(
        `Instance directory answered env "${parsed.env}", expected "${env}"`,
        false
      );
    const hosts = new Map<string, string>();
    for (const row of parsed.instances) {
      const host = row.host.toLowerCase();
      if (INSTANCE_NAME.test(row.instance) && HOSTNAME.test(host))
        hosts.set(row.instance, host);
    }
    return { fetchedAt: now(), hosts };
  }

  /** One directory read per node at a time. */
  function refresh(nodeId: string): Promise<Snapshot> {
    const pending = inflight.get(nodeId);
    if (pending) return pending;
    const read = readDirectory(nodeId)
      .then((snapshot) => {
        snapshots.set(nodeId, snapshot);
        return snapshot;
      })
      .finally(() => inflight.delete(nodeId));
    inflight.set(nodeId, read);
    return read;
  }

  const urlOf = (host: string) => `https://${host}`;

  return {
    async resolve(nodeId, instance) {
      if (!INSTANCE_NAME.test(instance))
        throw refuse(nodeId, instance, "not a valid instance name");
      const cached = snapshots.get(nodeId);
      if (cached) {
        const age = now() - cached.fetchedAt;
        const host = cached.hosts.get(instance);
        if (age < ttlMs && host) return urlOf(host);
        if (age < missRefreshMs)
          throw refuse(nodeId, instance, "not in the instance directory");
      }
      let snapshot: Snapshot;
      try {
        snapshot = await refresh(nodeId);
      } catch (err) {
        if (!(err instanceof DirectoryUnreachable)) throw err;
        // LAST_GOOD_ONLY_WHEN_UNREACHABLE: only an instance the last good read listed.
        if (cached) {
          const host = cached.hosts.get(instance);
          if (!host)
            throw refuse(nodeId, instance, "not in the instance directory");
          logger.warn(
            {
              nodeId,
              instance,
              err: err.message,
              ageMs: now() - cached.fetchedAt,
            },
            "instance directory unreachable; using the last good copy"
          );
          return urlOf(host);
        }
        throw new InstanceUnresolvedError(
          `${err.message}; no last good copy for node "${nodeId}"`,
          true
        );
      }
      const host = snapshot.hosts.get(instance);
      if (!host)
        throw refuse(nodeId, instance, "not in the instance directory");
      return urlOf(host);
    },
  };
}
