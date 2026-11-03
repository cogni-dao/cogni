// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/workload-manifest`
 * Purpose: Render a born node's `.cogni/workloads/app.yaml` — the workload manifest the node-deploy
 *   verb (`POST /api/v1/deploy/workloads`) reads at the deployed `sourceSha` (story.5137, task.5411).
 * Scope: Pure string render. Shape copies Cogni-DAO/node-template:.cogni/workloads/app.yaml with the
 *   route host renamed to the node's own PRODUCTION host; the verb derives the `-test` / `-preview`
 *   sibling per env (HOST_FOLLOWS_ENV, features/node-deploy/declarations.ts).
 * Invariants:
 *   - NO_SECRETS_IN_THE_MANIFEST: runtime env and secrets come from the operator (OpenBao custody).
 *   - ONE_HOST_PER_NODE: the host is `<slug>.<domainRoot>`; a node claims only its own host.
 * Side-effects: none
 * Links: packages/repo-spec/src/workload-manifest.ts, hub `workload-manifest`, story.5137
 * @public
 */

/** Repo-relative path of a node's app workload manifest in its OWN repo. */
export const NODE_APP_WORKLOAD_MANIFEST_PATH = ".cogni/workloads/app.yaml";

export interface RenderNodeAppWorkloadManifestInput {
  readonly slug: string;
  /** Container port the app listens on (3200 for the Cogni Next.js app). */
  readonly port: number;
  /** Public zone; omitted = `cognidao.org`. */
  readonly domainRoot?: string | undefined;
}

export function renderNodeAppWorkloadManifest(
  input: RenderNodeAppWorkloadManifestInput
): string {
  const host = `${input.slug}.${input.domainRoot ?? "cognidao.org"}`;
  return `# Workload manifest (hub \`workload-manifest\`, story.5137): this node's app on the operator's
# node-deploy verb. \`POST /api/v1/deploy/workloads {nodeId, env, workload: "app", sourceSha}\`
# reads this file at sourceSha. Image "." = the image this repo's CI built at that sha.
# Runtime env and secrets come from the operator (OpenBao custody), never from this file.
# Each merge to main ships through that one verb (story.5127): build once, blue/green, exact SHA.
apiVersion: score.dev/v1b1
metadata:
  name: app
  annotations:
    cogni.dev/exclusive: "false"
    cogni.dev/ephemeral-storage: 4Gi
containers:
  app:
    image: .
    resources:
      requests:
        cpu: "2"
        memory: 2048Mi
    readinessProbe:
      httpGet:
        path: /readyz
        port: ${input.port}
service:
  ports:
    web:
      port: 80
      targetPort: ${input.port}
resources:
  web:
    type: route
    params:
      host: ${host}
      path: /
      port: 80
`;
}
