// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/node-runtime-secrets.adapter`
 * Purpose: `NodeRuntimeSecretsPort` over the EXISTING custody path, OpenBao -> External Secrets Operator
 *   (ESO) -> a Kubernetes Secret — how the node-deploy sequencer reads the runtime secrets of a node app
 *   so the app runs with the SAME env the Crossplane lane gave it (task.5405).
 * Scope: Per read: ensure ONE ExternalSecret `nd-<slug>-env` in the sequencer's OWN dedicated namespace
 *   (`NODE_DEPLOY_SECRETS_NAMESPACE`, `cogni-node-deploy-<env>`), wait a bounded time for it to be Ready,
 *   then read its target Secret `nd-<slug>-env` and filter it. No OpenBao login, no new OpenBao role, no
 *   root token: ESO's own `eso-reader` role (ClusterSecretStore `openbao-backend`) is the ONLY reader of
 *   OpenBao, exactly as for every other ExternalSecret.
 * Invariants:
 *   - CUSTODY_STAYS_IN_OPENBAO: the value lives at `cogni/<env>/<slug>`; the Kubernetes Secret is the
 *     ESO-rendered view (`creationPolicy: Owner`, 5m refresh), never an authority.
 *   - SEQUENCER_IS_THE_ONE_WRITER_OF_THE_EXTERNALSECRET (CD4): it creates or updates only
 *     `nd-<slug>-env` in its own namespace; the Role grants externalsecrets verbs there and nowhere else.
 *   - DENYLIST_IS_APPLIED_HERE_TOO: keys on `OFF_CLUSTER_WORKLOAD_DENIED_KEYS` and malformed env names are
 *     dropped before the map leaves this class, so a caller can never forward one by mistake.
 *   - NO_HALF_ENV: not Ready in time, a missing Secret or absent/empty required keys throw
 *     `NodeRuntimeSecretsError` NAMING keys or the ESO reason (never values); the sequencer maps it to
 *     DependencyNotReady, so nothing is paid and the next tick retries while ESO keeps reconciling.
 *   - SLUG_IS_A_BUCKET_NAME: a DNS label that is not a reserved bucket (`operator`) and cannot collide
 *     with a state password Secret (`nd-<8 hex>-<workload>`).
 * Side-effects: IO (Kubernetes API: ExternalSecret get/create/replace, Secret get)
 * Links: infra/k8s/secrets/external-secrets/cluster-secret-store.yaml, infra/k8s/base/node-deploy-sequencer/rbac.yaml,
 *   ports/node-runtime.port.ts, shared/secrets/node-secrets-reserved.data.ts, docs/spec/secrets-management.md
 * @internal
 */

import {
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
} from "@kubernetes/client-node";

import { NodeRuntimeSecretsError, type NodeRuntimeSecretsPort } from "@/ports";
import { isOffClusterWorkloadSecretKey } from "@/shared/secrets/node-secrets-reserved.data";

const SLUG = /^[a-z][a-z0-9-]{0,56}$/;
/** `nd-<nodeId8>-<workload>` is the state password Secret name; a slug may not shape-match it. */
const STATE_SECRET_SHAPE = /^[0-9a-f]{8}-/;
const RESERVED_BUCKETS: ReadonlySet<string> = new Set(["operator"]);

const GROUP = "external-secrets.io";
const VERSION = "v1";
const PLURAL = "externalsecrets";
const STORE = { kind: "ClusterSecretStore", name: "openbao-backend" };
const REFRESH_INTERVAL = "5m";

/** The one name of both the ExternalSecret and the Secret it renders. */
export const nodeEnvSecretName = (slug: string): string => `nd-${slug}-env`;

export interface NodeRuntimeSecretsDeps {
  /** `NODE_DEPLOY_SECRETS_NAMESPACE`: the sequencer's own dedicated namespace. */
  readonly namespace: string;
  readonly core?: CoreV1Api;
  readonly custom?: CustomObjectsApi;
  /** Bound on the wait for a Ready ExternalSecret inside one `read` (default 20 s). */
  readonly readyTimeoutMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

interface ExternalSecretObject {
  metadata?: { resourceVersion?: string } & Record<string, unknown>;
  spec?: unknown;
  status?: {
    conditions?: {
      type?: string;
      status?: string;
      reason?: string;
      message?: string;
    }[];
  };
}

const statusCode = (e: unknown): number | undefined =>
  (e as { statusCode?: number; response?: { statusCode?: number } })
    .statusCode ??
  (e as { response?: { statusCode?: number } }).response?.statusCode;

function desiredSpec(env: string, slug: string) {
  return {
    refreshInterval: REFRESH_INTERVAL,
    secretStoreRef: STORE,
    target: {
      name: nodeEnvSecretName(slug),
      creationPolicy: "Owner",
    },
    dataFrom: [{ extract: { key: `${env}/${slug}` } }],
  };
}

export class EsoNodeRuntimeSecrets implements NodeRuntimeSecretsPort {
  private readonly core: CoreV1Api;
  private readonly custom: CustomObjectsApi;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: NodeRuntimeSecretsDeps) {
    if (deps.core && deps.custom) {
      this.core = deps.core;
      this.custom = deps.custom;
    } else {
      const kc = new KubeConfig();
      kc.loadFromCluster();
      this.core = deps.core ?? kc.makeApiClient(CoreV1Api);
      this.custom = deps.custom ?? kc.makeApiClient(CustomObjectsApi);
    }
    this.timeoutMs = deps.readyTimeoutMs ?? 20_000;
    this.pollMs = deps.pollMs ?? 1_000;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? (() => Date.now());
  }

  async read(
    env: string,
    slug: string,
    requiredKeys: readonly string[]
  ): Promise<Readonly<Record<string, string>>> {
    if (
      !SLUG.test(slug) ||
      RESERVED_BUCKETS.has(slug) ||
      STATE_SECRET_SHAPE.test(slug)
    )
      throw new NodeRuntimeSecretsError(
        "unavailable",
        "slug is not a node bucket name"
      );
    await this.ensureExternalSecret(env, slug);
    await this.awaitReady(slug);
    const values = await this.readTarget(slug);

    const injectable: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (isOffClusterWorkloadSecretKey(key)) injectable[key] = value;
    }
    const missing = requiredKeys.filter((k) => injectable[k] === undefined);
    if (missing.length > 0)
      throw new NodeRuntimeSecretsError(
        "missing_keys",
        `required keys missing: ${missing.join(", ")}`,
        missing
      );
    return injectable;
  }

  /** Create-or-update `nd-<slug>-env`. The spec is deterministic, so an unchanged object is not rewritten. */
  private async ensureExternalSecret(env: string, slug: string): Promise<void> {
    const name = nodeEnvSecretName(slug);
    const spec = desiredSpec(env, slug);
    const ns = this.deps.namespace;
    const body = (resourceVersion?: string) => ({
      apiVersion: `${GROUP}/${VERSION}`,
      kind: "ExternalSecret",
      metadata: {
        name,
        namespace: ns,
        labels: {
          "app.kubernetes.io/managed-by": "node-deploy-sequencer",
          "app.kubernetes.io/part-of": "cogni",
        },
        ...(resourceVersion ? { resourceVersion } : {}),
      },
      spec,
    });
    try {
      const existing = await this.getExternalSecret(name);
      if (!existing) {
        try {
          await this.custom.createNamespacedCustomObject(
            GROUP,
            VERSION,
            ns,
            PLURAL,
            body()
          );
        } catch (error) {
          if (statusCode(error) !== 409) throw error; // a racing creator won: reconcile below next read
        }
        return;
      }
      if (JSON.stringify(existing.spec) !== JSON.stringify(spec))
        await this.custom.replaceNamespacedCustomObject(
          GROUP,
          VERSION,
          ns,
          PLURAL,
          name,
          body(existing.metadata?.resourceVersion)
        );
    } catch (error) {
      throw new NodeRuntimeSecretsError(
        "unavailable",
        `externalsecret ensure failed (HTTP ${statusCode(error) ?? "n/a"})`
      );
    }
  }

  private async getExternalSecret(
    name: string
  ): Promise<ExternalSecretObject | undefined> {
    try {
      const res = await this.custom.getNamespacedCustomObject(
        GROUP,
        VERSION,
        this.deps.namespace,
        PLURAL,
        name
      );
      return res.body as ExternalSecretObject;
    } catch (error) {
      if (statusCode(error) === 404) return undefined;
      throw error;
    }
  }

  /** Bounded wait for `Ready=True`. A definite `Ready=False` fails fast with ESO's own reason. */
  private async awaitReady(slug: string): Promise<void> {
    const name = nodeEnvSecretName(slug);
    const deadline = this.now() + this.timeoutMs;
    for (;;) {
      let ready:
        | { status?: string; reason?: string; message?: string }
        | undefined;
      try {
        const es = await this.getExternalSecret(name);
        ready = es?.status?.conditions?.find((c) => c.type === "Ready");
      } catch (error) {
        throw new NodeRuntimeSecretsError(
          "unavailable",
          `externalsecret read failed (HTTP ${statusCode(error) ?? "n/a"})`
        );
      }
      if (ready?.status === "True") return;
      if (ready?.status === "False")
        throw new NodeRuntimeSecretsError(
          "unavailable",
          `externalsecret not ready: ${ready.reason ?? "unknown"}: ${(ready.message ?? "").slice(0, 160)}`
        );
      if (this.now() >= deadline)
        throw new NodeRuntimeSecretsError(
          "unavailable",
          "externalsecret not ready yet"
        );
      await this.sleep(this.pollMs);
    }
  }

  private async readTarget(slug: string): Promise<Record<string, string>> {
    let data: Record<string, string> | undefined;
    try {
      const res = await this.core.readNamespacedSecret(
        nodeEnvSecretName(slug),
        this.deps.namespace
      );
      data = res.body.data;
    } catch (error) {
      if (statusCode(error) === 404)
        throw new NodeRuntimeSecretsError(
          "unavailable",
          "target secret not rendered yet"
        );
      throw new NodeRuntimeSecretsError(
        "unavailable",
        `secret read failed (HTTP ${statusCode(error) ?? "n/a"})`
      );
    }
    const out: Record<string, string> = {};
    for (const [key, b64] of Object.entries(data ?? {})) {
      const value = Buffer.from(b64, "base64").toString("utf8");
      if (value.length > 0) out[key] = value;
    }
    return out;
  }
}
