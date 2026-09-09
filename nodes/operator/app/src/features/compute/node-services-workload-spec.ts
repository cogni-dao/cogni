// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/node-services-workload-spec`
 * Purpose: Assemble an atomically resolved node artifact bundle into one provider-neutral workload.
 * Scope: Pure declaration+digest mapping; no registry, secret, provider, or lifecycle I/O.
 * Invariants: DIGEST_PINNED, ONE_PUBLIC_SERVICE, PRIVATE_IS_NON_GLOBAL, BIND_ALL_INTERFACES, NO_RAW_ENV_INPUT,
 *   DECLARED_NOT_DEFAULTED — external compute refuses the legacy no-secrets fallback and says what to add.
 * Side-effects: none
 * Links: story.5016, task.5065, task.5079, @cogni/repo-spec artifact bundle
 * @internal
 */

import type { ProvisionServiceSpec, ProvisionSpec } from "@cogni/ai-tools";
import {
  hasDeclaredNodeDeployment,
  missingRuntimeProfileSecretKeys,
  type RepoSpec,
  type ResolvedNodeArtifactBundle,
  renderNodeDeploymentYaml,
} from "@cogni/repo-spec";

export interface NodeServicesWorkloadInput {
  /** Node slug used as the provider-neutral workload label. */
  readonly slug: string;
  /** Fully resolved, exact-set, digest-pinned artifact bundle. */
  readonly bundle: ResolvedNodeArtifactBundle;
  /** Custom hostnames accepted by the public ingress. */
  readonly hosts?: readonly string[];
}

export interface LegacyCogniAppCompatibilityInput
  extends NodeServicesWorkloadInput {
  /** Canonical URL used by the existing Cogni Next.js app image. */
  readonly publicUrl: string;
}

export interface NodeServicesProvisionServiceSpec extends ProvisionServiceSpec {
  /** Value-free requirements resolved server-side before provider I/O. */
  readonly secretRefs: readonly { readonly key: string }[];
  /** Explicit app compatibility selector; absent means generic runtime behavior. */
  readonly runtimeProfile?: "cogni-node-app-v1";
}

export interface NodeServicesWorkloadSpec
  extends Omit<ProvisionSpec, "services"> {
  readonly services: readonly NodeServicesProvisionServiceSpec[];
}

/**
 * Secret contract required by the explicit legacy Cogni application profile.
 * Re-exported from `@cogni/repo-spec`, where the profile itself is declared, so the node
 * scaffold that MINTS the block and the gate that REJECTS an incomplete one share one list.
 */
export { COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS } from "@cogni/repo-spec";

/**
 * Gate 1 — the earliest operator-owned read of a node's own repo-spec.
 *
 * A node with no `deployment:` block silently inherits the legacy default, whose `secret_refs`
 * are empty by design (the k3s lane injects env through its ExternalSecret overlay instead).
 * That default cannot boot an externally hosted workload, and accepting it here converts a
 * one-line repo-spec omission into a terminal reconcile failure hours later. So: refuse now,
 * and hand the author the exact block to paste. Capability-scoped — no node is named.
 */
export function assertDeclaredNodeDeployment(input: {
  readonly spec: RepoSpec;
  readonly slug: string;
  readonly sourceSha?: string | undefined;
}): void {
  if (hasDeclaredNodeDeployment(input.spec)) return;
  const at = input.sourceSha ? ` at ${input.sourceSha}` : "";
  throw new Error(
    [
      `[node-workload] ${input.slug}: external compute requires a \`deployment:\` block in the node's own .cogni/repo-spec.yaml${at}, and none is declared.`,
      "Without it the node falls back to a legacy default that declares NO secret_refs, so the workload would be created with no runtime environment and fail terminally at reconcile.",
      "Add this block to .cogni/repo-spec.yaml (this is exactly what the node scaffold emits for a new node) and re-run:",
      "",
      renderNodeDeploymentYaml().trimEnd(),
    ].join("\n")
  );
}

/** Gate 2 — fail before desired-state mutation when the declared profile omits a requirement. */
export function assertRuntimeProfileSecretRefs(input: {
  readonly serviceName?: string | undefined;
  readonly runtimeProfile?: "cogni-node-app-v1" | undefined;
  readonly secretRefs: readonly { readonly key: string }[];
}): void {
  const missing = missingRuntimeProfileSecretKeys(input);
  if (missing.length === 0) return;
  const path = `deployment.services[name=${input.serviceName ?? "app"}].secret_refs`;
  throw new Error(
    [
      `[node-workload] cogni-node-app-v1 is missing secret_refs: ${missing.join(", ")}`,
      `Declare them in the node's .cogni/repo-spec.yaml under ${path}:`,
      "",
      ...missing.map((key) => `  - key: ${key}`),
    ].join("\n")
  );
}

/** Build one generic co-located workload from the validated complete bundle. */
export function buildNodeServicesWorkloadSpec(
  input: NodeServicesWorkloadInput
): NodeServicesWorkloadSpec {
  return {
    name: input.slug,
    services: input.bundle.services.map(({ service, image }) => {
      assertRuntimeProfileSecretRefs({
        serviceName: service.name,
        ...(service.runtimeProfile
          ? { runtimeProfile: service.runtimeProfile }
          : {}),
        secretRefs: service.secretRefs,
      });
      const isPublic = service.visibility === "public";
      const bindingEnv = Object.fromEntries(
        Object.entries(service.bindings).map(([envName, targetName]) => {
          const target = input.bundle.services.find(
            (candidate) => candidate.service.name === targetName
          );
          if (!target) {
            // Defensive only: repo-spec validation already rejects missing targets.
            throw new Error(
              `[node-workload] Missing binding target ${service.name}.${envName} -> ${targetName}`
            );
          }
          return [envName, target.service.internalUrl];
        })
      );

      return {
        name: service.name,
        image,
        secretRefs: service.secretRefs,
        ...(service.runtimeProfile
          ? { runtimeProfile: service.runtimeProfile }
          : {}),
        // This generic layer accepts no caller-provided values. Every value is
        // deterministically derived from the Git service/topology declaration.
        env: {
          ...bindingEnv,
          HOST: service.bindHost,
          HOSTNAME: service.bindHost,
          PORT: String(service.port),
        },
        ...(service.command ? { command: service.command } : {}),
        ...(service.args ? { args: service.args } : {}),
        ...service.resources,
        expose: [
          {
            port: service.port,
            as: isPublic ? 80 : service.port,
            global: isPublic,
            ...(isPublic && input.hosts && input.hosts.length > 0
              ? { hosts: input.hosts }
              : {}),
          },
        ],
      };
    }),
  };
}

/**
 * Preserve the existing single Next.js node image's non-secret runtime config.
 *
 * This compatibility policy is deliberately named and app-specific. It is not
 * applied by the generic service mapper and it has no arbitrary env input;
 * secret refs are resolved later at the provider-I/O boundary.
 */
export function buildLegacyCogniAppWorkloadSpec(
  input: LegacyCogniAppCompatibilityInput
): NodeServicesWorkloadSpec {
  const workload = buildNodeServicesWorkloadSpec(input);
  const compatible = workload.services.filter(
    (service) => service.runtimeProfile === "cogni-node-app-v1"
  );
  const app = compatible[0];
  if (compatible.length !== 1 || !app || app.expose?.[0]?.global !== true) {
    throw new Error(
      "[node-workload] Legacy Cogni compatibility requires exactly one public cogni-node-app-v1 service"
    );
  }

  return {
    ...workload,
    services: workload.services.map((service) =>
      service.runtimeProfile === "cogni-node-app-v1"
        ? {
            ...service,
            env: {
              ...service.env,
              NODE_NAME: input.slug,
              COGNI_REPO_PATH: "/app",
              AUTH_TRUST_HOST: "true",
              NEXTAUTH_URL: input.publicUrl,
              APP_BASE_URL: input.publicUrl,
            },
          }
        : service
    ),
  };
}
