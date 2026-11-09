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
 *     of secret KEY names it may receive: the `cogni-node-app-v1` profile keys plus the catalog entries
 *     whose `workloads` names the app service (`resolveRuntimeProfileSecretRefs`, the helper the
 *     Crossplane lane used). Any operator/fleet/substrate credential on that list is refused here (`secret_ref_refused`), so
 *     it can never reach rented compute; fleet-inherited keys that are merely in the bucket are not
 *     on the list and are never delivered.
 *   - CATALOG_IS_THE_ONLY_SECRET_DECLARATION (bug.5254): a node's `.cogni/secrets-catalog.yaml` at the same
 *     sha is the ONE place a node declares a secret. Its entries whose `workloads` names the workload's
 *     repo-spec service are the keys beyond the profile. A repo-spec that still carries `secret_refs` is
 *     refused (`secret_ref_refused`, fixed message), never stripped (CD1). The catalog is checked whole
 *     (`parseNodeSecretsCatalog`, pass 1 + sovereign pass 2) before any workload resolves; a refused
 *     catalog refuses the release (`secrets_catalog_refused`). A catalog-projected key must be node-owned:
 *     a substrate-reserved, fleet-inherited or off-cluster-denied key is refused.
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
  catalogSecretKeysFor,
  extractNodeId,
  extractNodeServices,
  lowerWorkloadManifests,
  type NodeSecretsCatalogEntry,
  parseNodeSecretsCatalog,
  parseRepoSpec,
  RETIRED_SECRET_REFS_MESSAGE,
  resolveRuntimeProfileSecretRefs,
  SecretsCatalogError,
  WorkloadManifestError,
  type WorkloadManifestFile,
  type WorkloadManifestIssue,
} from "@cogni/repo-spec";

import { parse as parseYaml } from "yaml";

import type { NodeWorkloadSpec } from "@/ports";
import type { WorkloadZoneBinding } from "@/shared/node-registry/fleet-ownership";
import {
  inheritedKeyOwner,
  isNodeOwnedSecretKey,
  isOffClusterWorkloadSecretKey,
} from "@/shared/secrets/node-secrets-reserved.data";
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
  | "secret_ref_refused"
  | "secrets_catalog_refused";

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
  /** The node's `.cogni/secrets-catalog.yaml` at the same sha; `null` or absent = no catalog. */
  readonly secretsCatalogText?: string | null | undefined;
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
  } catch (error) {
    // A retired `secret_refs` fails with its own fixed text (bug.5254). Surface that constant only: the
    // schema's message can quote repo-spec text (NO_SOURCE_ECHO). The release is refused, never stripped.
    if (
      error instanceof Error &&
      error.message.includes(RETIRED_SECRET_REFS_MESSAGE)
    )
      throw new DeclarationError(
        "secret_ref_refused",
        RETIRED_SECRET_REFS_MESSAGE
      );
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
  const catalog = checkSecretsCatalog(
    spec,
    input.nodeSlug,
    input.secretsCatalogText ?? null
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
      const keys = workerSecretKeys(c.name, catalog);
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
          ? appSecretKeys(spec, catalog)
          : workerSecretKeys(service.name, catalog);
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
            secretKeys: workerSecretKeys(declared.name, catalog),
            runtimeProfile: "worker",
          }
        : { ...declared, secretKeys: appSecretKeys(spec, catalog) }
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
        secretKeys: workerSecretKeys(c.name, catalog),
      }));
    const { companions: _all, runtimeProfile: _profile, ...rest } = withKeys;
    withKeys = {
      ...rest,
      serviceName: main.name,
      secretKeys: appSecretKeys(spec, catalog),
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
 * The generate recipes for a resolved release (bug.5254): every key the spec already carries (app, worker
 * or companion `secretKeys`) that the node catalog declares `source: agent` with a generator. The key SET
 * is the spec's (one derivation, CD2); the catalog only supplies each key's recipe. The inputs passed
 * `resolveWorkloadDeclaration`, so they parse.
 */
export function generatedSecretRecipes(input: {
  readonly repoSpecText: string;
  readonly secretsCatalogText: string | null;
  readonly nodeSlug: string;
  readonly spec: NodeWorkloadSpec;
}): Record<string, { kind: "hex" | "base64"; bytes: number }> {
  if (input.secretsCatalogText === null || input.spec.kind !== "app") return {};
  const repoSpec = parseRepoSpec(
    parseYaml(input.repoSpecText, { prettyErrors: false, logLevel: "error" })
  );
  const catalog = parseNodeSecretsCatalog(input.secretsCatalogText, {
    nodeSlug: input.nodeSlug,
    serviceNames: extractNodeServices(repoSpec).map((s) => s.name),
  });
  const wanted = new Set([
    ...(input.spec.secretKeys ?? []),
    ...(input.spec.companions ?? []).flatMap((c) => c.secretKeys ?? []),
  ]);
  const out: Record<string, { kind: "hex" | "base64"; bytes: number }> = {};
  // Only an entry that PROJECTS the key (non-empty `workloads`) may generate it: that is the entry
  // `checkSecretsCatalog` proved node-owned. A profile key the catalog merely names never qualifies.
  for (const e of catalog)
    if (
      e.source === "agent" &&
      e.generate &&
      e.workloads.length > 0 &&
      wanted.has(e.name)
    )
      out[e.name] = { kind: e.generate.kind, bytes: e.generate.bytes };
  return out;
}

/**
 * Check the node's secrets catalog whole (bug.5254). Every key a catalog entry projects into a workload
 * must be node-owned: never substrate-reserved (the substrate mints it), fleet-inherited (another owner
 * holds the value) or off-cluster-denied (an operator/fleet credential).
 */
function checkSecretsCatalog(
  spec: ReturnType<typeof parseRepoSpec>,
  nodeSlug: string,
  text: string | null
): readonly NodeSecretsCatalogEntry[] {
  let catalog: readonly NodeSecretsCatalogEntry[];
  try {
    catalog = parseNodeSecretsCatalog(text, {
      nodeSlug,
      serviceNames: extractNodeServices(spec).map((s) => s.name),
    });
  } catch (error) {
    if (error instanceof SecretsCatalogError)
      throw new DeclarationError("secrets_catalog_refused", error.message);
    throw error;
  }
  // A projected key must never be a fleet credential: not fleet-inherited (another owner holds the
  // value) and not off-cluster-denied. That is the off-cluster denylist plus the inherited check. A
  // generated (`source: agent`) key must ALSO not be substrate-reserved: the substrate mints those,
  // and a second minter is the overwrite-by-another-door Gate 2 blocks. A node-owned reserved key
  // (e.g. POLY_WALLET_AEAD_KEY_HEX, `source: human`) may still be projected.
  const fleet = (k: string) =>
    inheritedKeyOwner(k) !== undefined || !isOffClusterWorkloadSecretKey(k);
  const refused = catalog
    .filter(
      (e) =>
        (e.workloads.length > 0 && fleet(e.name)) ||
        (e.source === "agent" &&
          (fleet(e.name) || !isNodeOwnedSecretKey(e.name)))
    )
    .map((e) => e.name);
  if (refused.length > 0)
    throw new DeclarationError(
      "secrets_catalog_refused",
      `catalog may not project a fleet credential or generate a substrate key; refused: ${refused.join(", ")}`
    );
  return catalog;
}

/** The repo-spec service that carries the node-app profile; a catalog names it to reach the app. */
function appServiceName(spec: ReturnType<typeof parseRepoSpec>): string {
  return (
    extractNodeServices(spec).find(
      (s) => s.runtimeProfile === "cogni-node-app-v1"
    )?.name ?? "app"
  );
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
 * The secret KEY names a worker may receive: ONLY the catalog entries whose `workloads` names its own
 * service (no profile keys). Throws `secret_ref_refused` on any denylisted key, exactly like an app.
 */
function workerSecretKeys(
  name: string,
  catalog: readonly NodeSecretsCatalogEntry[]
): string[] {
  const keys = [...new Set(catalogSecretKeysFor(catalog, name))];
  const refused = keys.filter((k) => !isOffClusterWorkloadSecretKey(k));
  if (refused.length > 0)
    throw new DeclarationError(
      "secret_ref_refused",
      `secret keys name operator/fleet credentials that may not reach an off-cluster workload: ${refused.join(", ")}`
    );
  return keys;
}

/**
 * The secret KEY names an app may receive: profile keys first (contract order), then the catalog entries
 * whose `workloads` names the app service, deduped. Throws `secret_ref_refused` on any denylisted key.
 */
function appSecretKeys(
  spec: ReturnType<typeof parseRepoSpec>,
  catalog: readonly NodeSecretsCatalogEntry[]
): string[] {
  const keys = [
    ...new Set([
      ...resolveRuntimeProfileSecretRefs({
        runtimeProfile: "cogni-node-app-v1",
      }).map((ref) => ref.key),
      ...catalogSecretKeysFor(catalog, appServiceName(spec)),
    ]),
  ];
  const refused = keys.filter((k) => !isOffClusterWorkloadSecretKey(k));
  if (refused.length > 0)
    throw new DeclarationError(
      "secret_ref_refused",
      `secret keys name operator/fleet credentials that may not reach an off-cluster workload: ${refused.join(", ")}`
    );
  return keys;
}
