// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/node-deploy/declarations`
 * Purpose: Turn a node's workload manifests (`.cogni/workloads/*.yaml`) plus its `.cogni/repo-spec.yaml`,
 *   all read at one `sourceSha` through the operator's GitHub App, into the ONE resolved
 *   `NodeWorkloadSpec` a release stores (task.5400, story.5137).
 * Scope: Pure checks; does not perform IO. The GitHub reads and the image-digest lookup live in the route; the release write lives in the store; the
 *   two-pass manifest check and the lowering live in `@cogni/repo-spec` (workload-manifest).
 * Invariants:
 *   - DECLARED_AT_THE_SHA: every manifest and the repo-spec come from the tree AT `sourceSha`, never
 *     from a mutable branch, and the resolved spec is frozen into the release row.
 *   - SPEC_IS_THE_NODES_OWN: the repo-spec `node_id` must equal the requested node; a tree that names
 *     another node is refused, so a caller can never deploy another node's workloads.
 *   - WHOLE_SET_CHECKED: all of the node's manifests are checked together (ids unique, ids differ from
 *     workload names) before any one workload resolves, so a refused sibling refuses the release.
 *   - EXCLUSIVE_IS_REFUSED (CD6): the manifest check refuses `cogni.dev/exclusive: "true"`, because
 *     blue and green overlap and the fenced lock that makes that safe is not built yet.
 *   - BUILT_IMAGE_IS_DIGEST_PINNED: an image of `.` lowers to the `builtImage` digest the caller resolved
 *     (`repo@sha256:<digest>`), or, when the caller defers (`pendingImage`, ALWAYS_DEFER, story.5137), to
 *     `<image_repository>:sha-<sha>` with `imagePending: true`; the sequencer pins the digest write-once
 *     before the first paid create. With neither it is refused `built_image_unresolved`, so a mutable tag
 *     never reaches a create.
 *   - SECRET_KEYS_ARE_DECLARED_NOT_DISCOVERED (task.5405): an `app` carries the explicit, value-free list
 *     of secret KEY names it may receive: the `cogni-node-app-v1` profile keys plus the app service's
 *     declared `secret_refs` (`resolveRuntimeProfileSecretRefs`, the helper the Crossplane lane used).
 *     Any operator/fleet/substrate credential on that list is refused here (`secret_ref_refused`), so
 *     it can never reach rented compute; fleet-inherited keys that are merely in the bucket are not
 *     on the list and are never delivered.
 *   - PLACEMENT_FOLLOWS_ENV (story.5141): the app carries the manifest's placement set for `env`
 *     (`placement.requiredCountryCodes`), frozen into the release with the rest of the spec (CD3).
 *   - HOST_FOLLOWS_ENV: a manifest names its PRODUCTION host; other environments get the
 *     `-test` (candidate-a) / `-preview` / `-dev` sibling of its first label, so one manifest serves
 *     every environment without a per-env copy.
 * Side-effects: none
 * Links: artifact-selection.ts, node-app-env.ts, bug.5568
 * @internal
 */

import {
  COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS,
  extractNodeAppSecretRefs,
  extractNodeId,
  extractNodeServices,
  lowerWorkloadManifests,
  parseRepoSpec,
  resolveRuntimeProfileSecretRefs,
  WorkloadManifestError,
  type WorkloadManifestFile,
  type WorkloadManifestIssue,
} from "@cogni/repo-spec";

import { parse as parseYaml } from "yaml";

import type { NodeWorkloadSpec } from "@/ports";
import type { WorkloadZoneBinding } from "@/shared/node-registry/fleet-ownership";
import { isOffClusterWorkloadSecretKey } from "@/shared/secrets/node-secrets-reserved.data";
import { hostForEnv, hostOwnedBy } from "./edge";
import { runtimeOwnedEnvKeys } from "./node-app-env";

const APP_PROFILE_KEYS: ReadonlySet<string> = new Set(
  COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS
);

export { HOST_ENVS, hostForEnv } from "./edge";

export type DeclarationErrorCode =
  | "repo_spec_unparseable"
  | "node_mismatch"
  | "workload_not_declared"
  | "workload_manifest_refused"
  | "secret_ref_refused";

export class DeclarationError extends Error {
  constructor(
    readonly code: DeclarationErrorCode,
    message: string,
    readonly issues: readonly WorkloadManifestIssue[] = []
  ) {
    super(message);
    this.name = "DeclarationError";
  }
}

export function resolveWorkloadDeclaration(input: {
  readonly workloadZone: WorkloadZoneBinding;
  readonly nodeSlug: string;
  readonly repoSpecText: string;
  readonly manifests: readonly WorkloadManifestFile[];
  readonly nodeId: string;
  readonly env: string;
  readonly workload: string;
  /** The digest-pinned image node CI built at the source sha; resolves a manifest image of `.`. */
  readonly builtImage?: string | undefined;
  /** `<image_repository>:sha-<sha>`: defers a manifest image of `.` to the sequencer (story.5137). */
  readonly pendingImage?: string | undefined;
  readonly sourceRepository?: string | undefined;
}): NodeWorkloadSpec {
  // NO_SOURCE_ECHO: parse the YAML without pretty errors, and never return the parser's or the
  // schema's message (either can quote repo-spec text).
  let raw: unknown;
  try {
    raw = parseYaml(input.repoSpecText, {
      prettyErrors: false,
      logLevel: "error",
    });
  } catch {
    throw new DeclarationError(
      "repo_spec_unparseable",
      "repo-spec is not valid YAML"
    );
  }
  let spec: ReturnType<typeof parseRepoSpec>;
  try {
    spec = parseRepoSpec(raw);
  } catch {
    throw new DeclarationError(
      "repo_spec_unparseable",
      "repo-spec does not match the repo-spec schema"
    );
  }
  if (extractNodeId(spec) !== input.nodeId)
    throw new DeclarationError(
      "node_mismatch",
      "the repo-spec at this sha belongs to a different node"
    );
  let workloads: NodeWorkloadSpec[];
  try {
    workloads = lowerWorkloadManifests(input.manifests, {
      env: input.env,
      ...(input.builtImage ? { builtImage: input.builtImage } : {}),
      ...(input.pendingImage ? { pendingImage: input.pendingImage } : {}),
    });
  } catch (error) {
    if (error instanceof WorkloadManifestError)
      throw new DeclarationError(
        "workload_manifest_refused",
        error.message,
        error.issues.slice(0, 20)
      );
    throw error;
  }
  const declared = workloads.find((w) => w.name === input.workload);
  if (!declared)
    throw new DeclarationError(
      "workload_not_declared",
      `workload ${input.workload} is not declared by any .cogni/workloads/*.yaml manifest`
    );
  // Validate the complete Score/declaration bridge BEFORE the environment cascade.
  for (const workload of workloads) {
    if (
      "http" in workload.expose &&
      !hostOwnedBy(
        input.workloadZone,
        workload.expose.http.host,
        "production",
        input.nodeSlug,
        isWorkerService(spec, workload.name) ? workload.name : undefined
      )
    )
      throw new DeclarationError(
        "workload_manifest_refused",
        "declaration must name this node's permitted production-form workload host"
      );
    if (!workload.companions && !workload.health?.qualification) continue;
    const services = extractNodeServices(spec);
    const main = services.find((s) => s.visibility === "public");
    if (
      !main ||
      (workload.serviceName !== "app" && workload.serviceName !== main.name) ||
      main.port !== workload.port ||
      !spec.deployment ||
      !input.pendingImage ||
      !input.sourceRepository
    )
      throw new DeclarationError(
        "workload_manifest_refused",
        "companion release requires matching public port and same-source build declarations"
      );
    const scoreNames = new Set([
      main.name,
      ...(workload.companions ?? []).map((c) => c.name),
    ]);
    if (
      services.length !== scoreNames.size ||
      services.some((s) => !scoreNames.has(s.name))
    )
      throw new DeclarationError(
        "workload_manifest_refused",
        "Score must cover the complete repo-spec service set"
      );
    for (const c of workload.companions ?? []) {
      const service = services.find((s) => s.name === c.name);
      if (
        !service ||
        service.visibility !== "private" ||
        service.runtimeProfile ||
        service.port !== c.port
      )
        throw new DeclarationError(
          "workload_manifest_refused",
          "companion must match a private unprofiled service and port"
        );
      const keys = workerSecretKeys(spec, c.name);
      if (
        keys.some(
          (k) =>
            APP_PROFILE_KEYS.has(k) ||
            /AUTH_SECRET|DATABASE|DOLTGRES|POSTGRES|PGPASSWORD|DB_|WALLET|PRIVATE_KEY|LITELLM|OPENROUTER/.test(
              k
            )
        )
      )
        throw new DeclarationError(
          "secret_ref_refused",
          "private companion cannot request app authority secrets"
        );
      if (
        Object.keys(c.env).some(
          (k) => keys.includes(k) || k in service.bindings
        )
      )
        throw new DeclarationError(
          "workload_manifest_refused",
          "companion variables conflict with declared secret or binding"
        );
    }
    for (const service of services) {
      const secretKeys =
        service.name === main.name
          ? appSecretKeys(spec)
          : workerSecretKeys(spec, service.name);
      const runtimeKeys = runtimeOwnedEnvKeys(
        service.name === main.name ? "app" : "worker",
        secretKeys
      );
      for (const [key, target] of Object.entries(service.bindings)) {
        const sibling = services.find((s) => s.name === target);
        const consumer =
          service.name === main.name
            ? workload
            : workload.companions?.find((c) => c.name === service.name);
        if (
          !sibling ||
          sibling.visibility !== "private" ||
          target === service.name ||
          !consumer ||
          key in consumer.env ||
          runtimeKeys.has(key) ||
          secretKeys.includes(key) ||
          (service.name === main.name &&
            workload.bindings.some((b) => b.env === key))
        )
          throw new DeclarationError(
            "workload_manifest_refused",
            "sibling binding must target a different private service without conflicting env"
          );
      }
    }
  }
  let withKeys: NodeWorkloadSpec =
    declared.kind === "app"
      ? isWorkerService(spec, declared.name)
        ? {
            ...declared,
            secretKeys: workerSecretKeys(spec, declared.name),
            runtimeProfile: "worker",
          }
        : { ...declared, secretKeys: appSecretKeys(spec) }
      : declared;
  if (declared.companions || declared.health?.qualification) {
    const services = extractNodeServices(spec);
    const main = services.find((s) => s.visibility === "public");
    if (
      !main ||
      !spec.deployment ||
      !input.pendingImage ||
      !input.sourceRepository
    )
      throw new DeclarationError(
        "workload_manifest_refused",
        "missing artifact plan"
      );
    const selected = services.filter(
      (s) => !s.envs || s.envs.some((e) => e === input.env)
    );
    const selectedNames = new Set(selected.map((s) => s.name));
    const bindingEnv = (name: string) =>
      Object.fromEntries(
        Object.entries(services.find((s) => s.name === name)?.bindings ?? {})
          .filter(([, target]) => selectedNames.has(target))
          .map(([k, target]) => {
            const c = declared.companions?.find((c) => c.name === target);
            if (!c)
              throw new DeclarationError(
                "workload_manifest_refused",
                "binding target missing from Score"
              );
            return [k, `http://${c.name}:${c.port}`];
          })
      );
    const companions = (declared.companions ?? [])
      .filter((c) => selectedNames.has(c.name))
      .map((c) => ({
        ...c,
        env: { ...c.env, ...bindingEnv(c.name) },
        secretKeys: workerSecretKeys(spec, c.name),
      }));
    const { companions: _all, runtimeProfile: _profile, ...rest } = withKeys;
    withKeys = {
      ...rest,
      serviceName: main.name,
      secretKeys: appSecretKeys(spec),
      ...(companions.length ? { companions } : {}),
      env: { ...rest.env, ...bindingEnv(main.name) },
      artifactPlan: {
        repository: input.sourceRepository.toLowerCase(),
        imageRepository: input.pendingImage.replace(/:sha-[0-9a-f]{40}$/, ""),
        services: spec.deployment.services,
      },
    };
  }
  if (!("http" in withKeys.expose)) return withKeys;
  return {
    ...withKeys,
    expose: {
      http: { host: hostForEnv(withKeys.expose.http.host, input.env) },
    },
  };
}

/**
 * True when `name` is a sibling worker of the node app (task.5272): the repo-spec has a service of that
 * name with NO runtime profile AND a distinct service carrying the node-app profile. Both must hold, so
 * a node whose own app service merely lacks `runtime_profile` still lowers as the node app (fail safe).
 */
function isWorkerService(
  spec: ReturnType<typeof parseRepoSpec>,
  name: string
): boolean {
  const services = extractNodeServices(spec);
  const own = services.find((s) => s.name === name);
  return (
    own !== undefined &&
    own.runtimeProfile === undefined &&
    services.some(
      (s) => s.name !== name && s.runtimeProfile === "cogni-node-app-v1"
    )
  );
}

/**
 * The secret KEY names a worker may receive: ONLY the `secret_refs` its own service declares (no profile
 * keys). Throws `secret_ref_refused` on any denylisted key, exactly like an app.
 */
function workerSecretKeys(
  spec: ReturnType<typeof parseRepoSpec>,
  name: string
): string[] {
  const keys = [
    ...new Set(
      (
        extractNodeServices(spec).find((s) => s.name === name)?.secretRefs ?? []
      ).map((r) => r.key)
    ),
  ];
  const refused = keys.filter((k) => !isOffClusterWorkloadSecretKey(k));
  if (refused.length > 0)
    throw new DeclarationError(
      "secret_ref_refused",
      `secret_refs name operator/fleet credentials that may not reach an off-cluster workload: ${refused.join(", ")}`
    );
  return keys;
}

/**
 * The secret KEY names an app may receive: profile keys first (contract order), then the app service's
 * extra declared `secret_refs`, deduped. Extra refs come from the repo-spec top-level `secret_refs`
 * (task.5411); a not-yet-migrated node's `deployment.services[]` app-service refs are the fallback
 * (`extractNodeAppSecretRefs`). Throws `secret_ref_refused` on any denylisted key.
 */
function appSecretKeys(spec: ReturnType<typeof parseRepoSpec>): string[] {
  const keys = resolveRuntimeProfileSecretRefs({
    runtimeProfile: "cogni-node-app-v1",
    secretRefs: extractNodeAppSecretRefs(spec),
  }).map((ref) => ref.key);
  const refused = keys.filter((k) => !isOffClusterWorkloadSecretKey(k));
  if (refused.length > 0)
    throw new DeclarationError(
      "secret_ref_refused",
      `secret_refs name operator/fleet credentials that may not reach an off-cluster workload: ${refused.join(", ")}`
    );
  return keys;
}
