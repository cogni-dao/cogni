// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/akash-tx-actuator-runtime`
 * Purpose: Pin the seams that decide whether Crossplane can REACH the Akash transaction actuator.
 *   Each one is a silent, deploy-time-only failure otherwise: nothing in CI builds these
 *   overlays, and the symptom is a connection error hours later on a manifest that renders
 *   perfectly (task.5102).
 * Scope: Static assertions over the app-lane manifests + the image entrypoint wiring; does not
 *   render kustomize, reach a cluster, or touch a provider.
 * Invariants:
 *   - ADDRESS_IS_THE_CONTRACT: the Service is named exactly `akash-tx-actuator` on port 8080,
 *     and the overlay's `operator-` namePrefix is undone for it.
 *   - PRIVATE_BY_CONSTRUCTION: ClusterIP only — no Ingress, no NodePort, no public route.
 *   - LEAST_PRIVILEGE_CREDENTIALS: an explicit projected key list, never `envFrom` over the
 *     whole operator Secret.
 *   - WALLET_IS_UNREACHABLE_FROM_THE_OPERATOR_APP: the Console credential and the bearer token
 *     live in the actuator's OWN OpenBao bucket + ExternalSecret, so the public operator app —
 *     which consumes ALL of `cogni/<env>/operator` via `dataFrom: extract` + `envFrom` — has no
 *     object that can reach them (story.5016 secret-boundary amendment 2).
 *   - NEVER_HOLDS_TWO_WALLETS: `AKASH_CONSOLE_API_KEY` is not projected into the actuator at all
 *     (amendment 3); separation is asserted against the non-secret pinned account id.
 *   - REFUSAL_IS_DIAGNOSABLE: every projected credential source is `optional: true` so the
 *     PROCESS reaches its own fail-closed refusal and names the missing credential. A
 *     non-optional source hands the failure to kubelet, which stalls the pod in
 *     ContainerCreating and emits only a `FailedMount` event that never reaches Loki
 *     (bug.5142). The security half is pinned separately: each credential still has a
 *     throwing refusal in the boot path.
 *   - ENTRYPOINT_EXISTS: the Deployment's command path is the path the Dockerfile copies.
 *   - LEAST_KUBERNETES_PRIVILEGE: the actuator runs as its OWN ServiceAccount, bound to a
 *     namespaced Role that grants exactly the migration prover's calls (batch/jobs
 *     get+list+create+delete, pods list) and NOTHING else — no computeworkloads, no leases, no
 *     events, no configmaps, no ClusterRole (story.5016).
 * Side-effects: IO (reads infra/k8s, the secrets catalog, and the operator image manifests)
 * Links: infra/k8s/base/akash-tx-actuator, infra/crossplane/xcomputeworkload/composition.yaml,
 *   nodes/operator/app/src/bootstrap/akash-tx-actuator.ts, task.5102, story.5016
 * @public
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";
import {
  CROSSPLANE_ACTUATOR_WALLET_ENVS,
  CROSSPLANE_CONTROL_PLANE_ENVS,
} from "@/shared/node-registry/crossplane-control-plane";

const REPO_ROOT = path.resolve(__dirname, "../..");
const read = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");
const parse = <T>(relative: string): T => yaml.parse(read(relative)) as T;

/**
 * The exact address `infra/crossplane/xcomputeworkload/composition.yaml` builds from the
 * XR's namespace. It cannot know a kustomize prefix, so these three literals are a wire
 * contract, not a preference.
 */
const SERVICE_NAME = "akash-tx-actuator";
const SERVICE_PORT = 8080;
const AUTH_SECRET_NAME = "akash-tx-actuator-auth";
const AUTH_SECRET_KEY = "token";
/** The actuator's dedicated OpenBao service + the k8s Secret its ExternalSecret produces. */
const OPENBAO_SERVICE = "akash-tx-actuator";
const ENV_SECRET_NAME = "akash-tx-actuator-env-secrets";
const ENVIRONMENT = "candidate-a";
/** The credentials that must NEVER be reachable from the public operator app's bucket. */
const ACTUATOR_OWNED_KEYS = [
  "AKASH_ACTUATOR_CONSOLE_API_KEY",
  "AKASH_TX_ACTUATOR_TOKEN",
] as const;

const BASE = "infra/k8s/base/akash-tx-actuator";
const OVERLAY = "infra/k8s/overlays/candidate-a/operator";
/**
 * The FUNDED/writer environments — exactly those whose overlay must ship the actuator base,
 * transformer, and the two actuator ExternalSecrets. Derived from the single source of truth
 * (`CROSSPLANE_ACTUATOR_WALLET_ENVS`), never a duplicate literal, so it can never drift: preview
 * is a dormant/unfunded control plane and must NOT ship the actuator (story.5016).
 */
const ACTUATOR_ENVIRONMENTS = CROSSPLANE_ACTUATOR_WALLET_ENVS;
/**
 * The control-plane environments that are INSTALLED but pin NO wallet — the dormant/unfunded set
 * (CONTROL_PLANE minus WALLET, i.e. preview). Locking these to have NO actuator overlay artifacts
 * mirrors the account-injective guard at the overlay layer: an unfunded env that shipped an
 * actuator would be a second active writer on a shared wallet.
 */
const DORMANT_CONTROL_PLANE_ENVIRONMENTS = CROSSPLANE_CONTROL_PLANE_ENVS.filter(
  (environment) =>
    !(CROSSPLANE_ACTUATOR_WALLET_ENVS as readonly string[]).includes(
      environment
    )
);

interface K8sObject {
  readonly kind: string;
  readonly metadata: { readonly name: string };
  readonly spec: Record<string, unknown>;
}

const service = parse<K8sObject>(`${BASE}/service.yaml`);
const deployment = parse<K8sObject>(`${BASE}/deployment.yaml`);
const overlay = parse<{
  readonly resources: readonly string[];
  readonly transformers?: readonly string[];
  readonly namePrefix?: string;
}>(`${OVERLAY}/kustomization.yaml`);

interface ProjectedSecretSource {
  readonly secret: {
    readonly name: string;
    readonly items: { readonly key: string }[];
  };
}

function projectedSources(): ProjectedSecretSource[] {
  const volumes = (
    deployment.spec as {
      template: { spec: { volumes: { projected?: { sources: unknown[] } }[] } };
    }
  ).template.spec.volumes;
  const sources = volumes[0]?.projected?.sources;
  expect(sources).toBeDefined();
  return sources as ProjectedSecretSource[];
}

function container(): Record<string, unknown> {
  const spec = deployment.spec as {
    template: { spec: { containers: Record<string, unknown>[] } };
  };
  const found = spec.template.spec.containers[0];
  expect(found).toBeDefined();
  return found as Record<string, unknown>;
}

describe("akash-tx-actuator runtime", () => {
  it("is the sole compute writer in every funded environment", () => {
    for (const environment of ACTUATOR_ENVIRONMENTS) {
      const root = `infra/k8s/overlays/${environment}/operator`;
      const environmentOverlay = parse<{
        readonly resources: readonly string[];
        readonly transformers?: readonly string[];
      }>(`${root}/kustomization.yaml`);

      expect(environmentOverlay.resources, environment).toContain(
        `../../../base/${SERVICE_NAME}`
      );
      expect(environmentOverlay.resources, environment).not.toContain(
        "../../../base/compute-workload-controller"
      );
      expect(environmentOverlay.transformers, environment).toContain(
        `../../../base/${SERVICE_NAME}-service-name`
      );

      const actuatorExternal = parse<{
        spec: { dataFrom: { extract: { key: string } }[] };
      }>(`${root}/akash-tx-actuator-external-secret.yaml`);
      expect(actuatorExternal.spec.dataFrom[0]?.extract.key, environment).toBe(
        `${environment}/${OPENBAO_SERVICE}`
      );

      const authExternal = parse<{
        spec: {
          data: { remoteRef: { key: string; property: string } }[];
        };
      }>(`${root}/akash-tx-actuator-auth-external-secret.yaml`);
      expect(authExternal.spec.data, environment).toEqual([
        {
          secretKey: AUTH_SECRET_KEY,
          remoteRef: {
            key: `${environment}/${OPENBAO_SERVICE}`,
            property: "AKASH_TX_ACTUATOR_TOKEN",
          },
        },
      ]);
    }
  });

  it("ships NO actuator into a dormant/unfunded control-plane environment", () => {
    // The mirror of the funded assertion above: an installed-but-unfunded control plane (preview)
    // must NOT carry a second writer against a wallet another env already writes. If this loop
    // ever runs empty because every control-plane env became funded, the assertion below makes
    // that explicit rather than silently vacuous.
    expect(
      DORMANT_CONTROL_PLANE_ENVIRONMENTS.length,
      "expected at least one dormant/unfunded control-plane env (preview)"
    ).toBeGreaterThan(0);

    for (const environment of DORMANT_CONTROL_PLANE_ENVIRONMENTS) {
      const root = `infra/k8s/overlays/${environment}/operator`;
      const environmentOverlay = parse<{
        readonly resources?: readonly string[];
        readonly transformers?: readonly string[];
      }>(`${root}/kustomization.yaml`);

      expect(environmentOverlay.resources ?? [], environment).not.toContain(
        `../../../base/${SERVICE_NAME}`
      );
      expect(environmentOverlay.transformers ?? [], environment).not.toContain(
        `../../../base/${SERVICE_NAME}-service-name`
      );
      expect(environmentOverlay.resources ?? [], environment).not.toContain(
        "./akash-tx-actuator-external-secret.yaml"
      );
      expect(environmentOverlay.resources ?? [], environment).not.toContain(
        "./akash-tx-actuator-auth-external-secret.yaml"
      );

      // The actuator ExternalSecret manifests must not exist on disk in a dormant overlay.
      expect(
        existsSync(
          path.join(REPO_ROOT, root, "akash-tx-actuator-external-secret.yaml")
        ),
        `${environment} must not carry an actuator ExternalSecret`
      ).toBe(false);
      expect(
        existsSync(
          path.join(
            REPO_ROOT,
            root,
            "akash-tx-actuator-auth-external-secret.yaml"
          )
        ),
        `${environment} must not carry an actuator auth ExternalSecret`
      ).toBe(false);
    }
  });

  it("serves at the exact address the Composition dials", () => {
    expect(service.metadata.name).toBe(SERVICE_NAME);
    expect(service.spec.type).toBe("ClusterIP");
    expect(service.spec.ports).toEqual([
      { name: "http", port: SERVICE_PORT, targetPort: "http", protocol: "TCP" },
    ]);
    expect(container().ports).toEqual([
      { name: "http", containerPort: SERVICE_PORT },
    ]);
  });

  it("undoes the overlay namePrefix for that Service", () => {
    // Without the post-prefix transformer the object renders as
    // `operator-akash-tx-actuator` and EVERY Crossplane OBSERVE is connection-refused.
    expect(overlay.namePrefix).toBe("operator-");
    expect(overlay.resources).toContain(`../../../base/${SERVICE_NAME}`);
    expect(overlay.transformers).toContain(
      `../../../base/${SERVICE_NAME}-service-name`
    );
    const transformer = parse<{
      readonly patch: string;
      readonly target: Record<string, unknown>;
    }>(`infra/k8s/base/${SERVICE_NAME}-service-name/service-name.yaml`);
    expect(JSON.parse(transformer.patch)).toEqual([
      { op: "replace", path: "/metadata/name", value: SERVICE_NAME },
    ]);
    expect(transformer.target).toMatchObject({ kind: "Service" });
  });

  it("stays private: no Ingress, no NodePort, no public route", () => {
    const manifests = `${read(`${BASE}/service.yaml`)}\n${read(
      `${BASE}/deployment.yaml`
    )}`;
    expect(manifests).not.toMatch(/kind:\s*Ingress/);
    expect(manifests).not.toMatch(/nodePort/);
    expect(service.spec).not.toHaveProperty("externalIPs");
  });

  it("receives only the three credentials it needs, as files, from two blast radii", () => {
    // envFrom over operator-env-secrets would hand a wallet writer the whole operator
    // bucket; an explicit item list is the blast radius we actually want.
    expect(container()).not.toHaveProperty("envFrom");
    const sources = projectedSources();

    // The wallet + the token that unlocks it come from the actuator's OWN Secret.
    expect(sources[0]?.secret.name).toBe(ENV_SECRET_NAME);
    expect(sources[0]?.secret.items.map((item) => item.key)).toEqual([
      ...ACTUATOR_OWNED_KEYS,
    ]);
    // Only the ledger DSN legitimately comes from the operator bucket: the receipts table is
    // operator-local schema in the operator's own Postgres.
    expect(sources[1]?.secret.name).toBe("operator-env-secrets");
    expect(sources[1]?.secret.items.map((item) => item.key)).toEqual([
      "DATABASE_URL",
    ]);
    expect(sources).toHaveLength(2);
  });

  it("makes its refusal diagnosable: optional sources + a named refusal per credential", () => {
    // INVERTED FROM THE ORIGINAL ASSERTION, deliberately (bug.5142). This used to require
    // the absence of `optional`, reasoning that "a missing wallet must CrashLoop, never
    // silently start an unauthenticated writer". The GOAL is right and is kept below; the
    // MECHANISM was backwards.
    //
    // kubelet refuses to mount a projected Secret whose object — or whose listed `key` —
    // does not exist. A non-optional source therefore does NOT produce a CrashLoop: the
    // pod never leaves ContainerCreating and the container never runs, so the boot path's
    // three named refusals never execute. The only signal left is a kubelet `FailedMount`
    // event, which never reaches Loki and reads like an infrastructure fault rather than
    // "nobody has written the Console key yet" — the normal state during a wallet cutover,
    // and ~25 minutes of misdiagnosis on candidate-a.
    //
    // So: `optional: true` is what lets the process reach its own refusal.
    for (const source of projectedSources()) {
      expect(source.secret).toHaveProperty("optional", true);
    }

    // The security half of the original invariant, now pinned EXPLICITLY rather than
    // implied by the mount. Optional would be a real regression if the process merely
    // warned and continued, so assert each projected credential still has a fail-closed
    // refusal in the boot path. ONE_WALLET_ONE_WRITER is enforced here, not by kubelet.
    const boot = read("nodes/operator/app/src/bootstrap/akash-tx-actuator.ts");
    expect(boot).toContain("akash_tx_actuator_wallet_unresolved");
    expect(boot).toContain("akash_tx_actuator_token_missing");
    expect(boot).toContain("akash_tx_actuator_ledger_dsn_missing");
    // Each refusal must THROW — a logged-and-continued wallet writer is the failure mode
    // this whole seam exists to prevent.
    expect(boot).toMatch(/refusing to expose an unauthenticated wallet writer/);
    expect(boot).toMatch(/must not spend without a durable receipt/);
  });

  it("NEVER projects the legacy controller wallet — it must not possess both", () => {
    // task.5095 projected AKASH_CONSOLE_API_KEY purely to byte-compare it, which meant the
    // actuator held the very credential it claimed isolation from (story.5016 amendment 3).
    const projectedKeys = projectedSources().flatMap((source) =>
      source.secret.items.map((item) => item.key)
    );
    expect(projectedKeys).not.toContain("AKASH_CONSOLE_API_KEY");
    // The replacement is a NON-SECRET pin, carried as plain Deployment config.
    const envNames = (container().env as { name: string }[] | undefined)?.map(
      (entry) => entry.name
    );
    expect(envNames).toContain("AKASH_ACTUATOR_ACCOUNT_ID");
  });

  it("keeps the wallet structurally unreachable from the public operator app", () => {
    // The operator ExternalSecret extracts the WHOLE operator bucket into the Secret the
    // public app takes via envFrom. So the only durable guarantee is that these keys are not
    // in that bucket at all — asserted at the catalog, which is the one reader (Invariant 14).
    const catalog = yaml.parse(read("infra/secrets-catalog.yaml")) as {
      secrets: { name: string; service?: string; source: string }[];
    };
    for (const key of ACTUATOR_OWNED_KEYS) {
      const entry = catalog.secrets.find((secret) => secret.name === key);
      expect(entry, `${key} must be declared in the catalog`).toBeDefined();
      expect(entry?.service).toBe(OPENBAO_SERVICE);
    }

    // The operator's own ExternalSecret extracts a DIFFERENT path, and the actuator's
    // dedicated one is what produces the Secret the pod mounts.
    const operatorExternal = parse<{
      spec: {
        target: { name: string };
        dataFrom: { extract: { key: string } }[];
      };
    }>(`${OVERLAY}/external-secret.yaml`);
    expect(operatorExternal.spec.dataFrom[0]?.extract.key).toBe(
      `${ENVIRONMENT}/operator`
    );

    const actuatorExternal = parse<{
      spec: {
        target: { name: string };
        dataFrom: { extract: { key: string } }[];
      };
    }>(`${OVERLAY}/akash-tx-actuator-external-secret.yaml`);
    expect(actuatorExternal.spec.target.name).toBe(ENV_SECRET_NAME);
    expect(actuatorExternal.spec.dataFrom[0]?.extract.key).toBe(
      `${ENVIRONMENT}/${OPENBAO_SERVICE}`
    );
    expect(overlay.resources).toContain(
      "./akash-tx-actuator-external-secret.yaml"
    );

    // Nothing in the overlay may hand the operator Deployment the actuator's Secret.
    const operatorPatches = read(`${OVERLAY}/kustomization.yaml`);
    expect(operatorPatches).not.toMatch(
      new RegExp(`secretRef:\\s*\\n\\s*name:\\s*["']?${ENV_SECRET_NAME}`)
    );
  });

  it("mints the bearer token instead of asking a human to type it", () => {
    // cicd-secrets-expert killer rule: a generated value must never be human-supplied.
    const catalog = yaml.parse(read("infra/secrets-catalog.yaml")) as {
      secrets: {
        name: string;
        source: string;
        generate?: { kind: string; bytes?: number };
      }[];
    };
    const token = catalog.secrets.find(
      (secret) => secret.name === "AKASH_TX_ACTUATOR_TOKEN"
    );
    expect(token?.source).toBe("agent");
    // An EXISTING generator kind, not a bespoke one (same as GH_WEBHOOK_SECRET).
    expect(token?.generate).toEqual({ kind: "hex", bytes: 32 });
  });

  it("declares the platform-service boundary identically in TypeScript and bash", () => {
    // The TS loader gates the catalog's `service:` allowlist; the bash materializer decides
    // which non-node buckets get minted. A drift between them is a key that is declared but
    // never materialized (or vice versa) — silent until the pod CrashLoops in an environment.
    const ts = read("scripts/lib/secrets-catalog-loader.ts");
    const tsSet =
      /PLATFORM_SERVICES:\s*ReadonlySet<string>\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(
        ts
      );
    expect(tsSet, "PLATFORM_SERVICES must exist in the loader").not.toBeNull();
    const tsNames = [...(tsSet?.[1] ?? "").matchAll(/"([^"]+)"/g)]
      .map((match) => match[1])
      .sort();

    const sh = read("scripts/setup/lib/reconcile-secrets.sh");
    const shBlock = /declare -ga PLATFORM_SERVICES=\(([\s\S]*?)\)/.exec(sh);
    expect(
      shBlock,
      "PLATFORM_SERVICES must exist in the bash lib"
    ).not.toBeNull();
    const shNames = (shBlock?.[1] ?? "")
      .split("\n")
      .map((line) => line.replace(/#.*$/, "").trim())
      .filter(Boolean)
      .sort();

    expect(shNames).toEqual(tsNames);
    expect(tsNames).toContain(OPENBAO_SERVICE);
  });

  it("projects the bearer token under the name the provider-http placeholder dereferences", () => {
    const external = parse<{
      spec: {
        target: { name: string };
        data: { secretKey: string; remoteRef: { property: string } }[];
      };
    }>(`${OVERLAY}/akash-tx-actuator-auth-external-secret.yaml`);
    expect(external.spec.target.name).toBe(AUTH_SECRET_NAME);
    expect(external.spec.data).toHaveLength(1);
    expect(external.spec.data[0]?.secretKey).toBe(AUTH_SECRET_KEY);
    // Same OpenBao key the pod reads, so the two sides cannot drift.
    expect(external.spec.data[0]?.remoteRef.property).toBe(
      "AKASH_TX_ACTUATOR_TOKEN"
    );
    expect(overlay.resources).toContain(
      "./akash-tx-actuator-auth-external-secret.yaml"
    );
  });

  it("runs as its OWN ServiceAccount with only the migration prover's rights", () => {
    // story.5016 gave the actuator a Kubernetes identity so its fail-closed migration gate has a
    // prover. That identity must stay the SMALLEST one that runs a Job: sharing
    // compute-workload-controller's SA would have handed a wallet writer ComputeWorkload-patch
    // and Lease rights for free, and every extra verb here is one an exploit inherits.
    const podSpec = (
      deployment.spec as {
        template: { spec: { serviceAccountName?: string } };
      }
    ).template.spec;
    expect(podSpec.serviceAccountName).toBe(SERVICE_NAME);

    const base = yaml.parse(read(`${BASE}/kustomization.yaml`)) as {
      resources: readonly string[];
    };
    expect(base.resources).toContain("service-account.yaml");
    expect(base.resources).toContain("rbac.yaml");

    const serviceAccount = parse<K8sObject>(`${BASE}/service-account.yaml`);
    expect(serviceAccount.kind).toBe("ServiceAccount");
    expect(serviceAccount.metadata.name).toBe(SERVICE_NAME);

    const rbac = yaml.parseAllDocuments(read(`${BASE}/rbac.yaml`)).map(
      (document) =>
        document.toJS() as {
          kind: string;
          metadata: { name: string };
          rules?: {
            apiGroups: string[];
            resources: string[];
            verbs: string[];
          }[];
          roleRef?: { kind: string; name: string };
          subjects?: { kind: string; name: string }[];
        }
    );
    // Namespaced only: a ClusterRole would let one namespace's actuator read another's.
    expect(rbac.map((document) => document.kind)).toEqual([
      "Role",
      "RoleBinding",
    ]);

    const [role, binding] = rbac;
    // Exact equality, not `toContain`: the point of this test is what is ABSENT.
    expect(role?.rules).toEqual([
      {
        apiGroups: ["batch"],
        resources: ["jobs"],
        verbs: ["get", "list", "create", "delete"],
      },
      { apiGroups: [""], resources: ["pods"], verbs: ["list"] },
    ]);
    expect(binding?.roleRef).toEqual({
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Role",
      name: SERVICE_NAME,
    });
    expect(binding?.subjects).toEqual([
      { kind: "ServiceAccount", name: SERVICE_NAME },
    ]);
  });

  it("starts an entrypoint the image actually contains", () => {
    const entrypoint = `/app/nodes/operator/app/${SERVICE_NAME}.mjs`;
    expect(container().command).toEqual(["node", entrypoint]);
    const dockerfile = read("nodes/operator/app/Dockerfile");
    expect(dockerfile).toContain(
      `dist-${SERVICE_NAME}/${SERVICE_NAME}.mjs ./nodes/operator/app/${SERVICE_NAME}.mjs`
    );
    expect(dockerfile).toContain(
      `pnpm --filter operator build:${SERVICE_NAME}`
    );
    const pkg = JSON.parse(read("nodes/operator/app/package.json")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts[`build:${SERVICE_NAME}`]).toBe(
      `tsup --config tsup.${SERVICE_NAME}.config.ts`
    );
    const tsup = read(`nodes/operator/app/tsup.${SERVICE_NAME}.config.ts`);
    expect(tsup).toContain(`entry: ["src/bootstrap/${SERVICE_NAME}.ts"]`);
    expect(tsup).toContain(`outDir: "dist-${SERVICE_NAME}"`);
  });
});
