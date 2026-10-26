// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@adapters/server/vcs/maintenance-cancel`
 * Purpose: Retire an unchanged, unexecuted candidate maintenance intent through the operator App.
 * Scope: One marker deletion in Git; no workflow, engine, lease or credential mutation.
 * Invariants: configured custody, complete inventory, pre-fence tree equality, non-force update.
 * Side-effects: IO (GitHub REST API)
 * Links: task.5345, ordinary-node-delivery-boundary
 * @internal
 */
import { createHash } from "node:crypto";
import type { Octokit } from "@octokit/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type {
  CancelCandidateMaintenanceInput,
  CancelCandidateMaintenanceResult,
} from "@/ports";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const markerSchema = z.object({
  version: z.literal(1),
  phase: z.literal("fenced"),
  operationId: z.string().regex(/^[a-f0-9]{64}$/),
  request: z.object({
    nodeId: z.string().uuid(),
    slug: z.string(),
    env: z.literal("candidate-a"),
    sourceRepository: z.string(),
    expected: z.object({ deployCommit: sha }),
  }),
  phaseEvidence: z.object({
    phase: z.literal("fenced"),
    nodeId: z.string().uuid(),
    environment: z.literal("candidate-a"),
  }),
});
function refuse(code: string, status = 409): never {
  throw Object.assign(new Error(code), { code, status });
}

export async function cancelCandidateMaintenance(
  octokit: Octokit,
  owner: string,
  repo: string,
  input: CancelCandidateMaintenanceInput
): Promise<CancelCandidateMaintenanceResult> {
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug) ||
    input.env !== "candidate-a" ||
    !sha.safeParse(input.expectedDeployHead).success ||
    !/^[a-f0-9]{64}$/.test(input.expectedMarkerSha256) ||
    !/^[a-f0-9]{64}$/.test(input.operationId)
  )
    refuse("maintenance_invalid_identity", 400);
  const common = {
    owner,
    repo,
    request: { signal: AbortSignal.timeout(10_000) },
  };
  const branch = `deploy/candidate-a-${input.slug}`;
  const { data: catalogFile } = await octokit.request(
    "GET /repos/{owner}/{repo}/contents/{path}",
    { ...common, path: `infra/catalog/${input.slug}.yaml`, ref: "main" }
  );
  if (
    Array.isArray(catalogFile) ||
    catalogFile.type !== "file" ||
    catalogFile.encoding !== "base64" ||
    catalogFile.size > 65536
  )
    refuse("maintenance_catalog_unproven");
  const catalog = z
    .object({
      name: z.string(),
      node_id: z.string().uuid(),
      envs: z.array(z.string()),
      candidate_a_branch: z.string().optional(),
      source_repo: z.string().url().optional(),
    })
    .safeParse(
      parseYaml(Buffer.from(catalogFile.content, "base64").toString("utf8"))
    );
  if (
    !catalog.success ||
    catalog.data.name !== input.slug ||
    catalog.data.node_id !== input.nodeId ||
    !catalog.data.envs.includes("candidate-a") ||
    (catalog.data.candidate_a_branch !== undefined &&
      catalog.data.candidate_a_branch !== branch)
  )
    refuse("maintenance_catalog_mismatch");
  const sourceRepository = catalog.data.source_repo
    ? new URL(catalog.data.source_repo)
    : null;
  if (
    sourceRepository &&
    (sourceRepository.protocol !== "https:" ||
      sourceRepository.hostname !== "github.com")
  )
    refuse("maintenance_catalog_mismatch");
  const source = sourceRepository
    ? sourceRepository.pathname.slice(1).replace(/\.git$/, "")
    : `${owner}/${repo}`;
  const { data: ref } = await octokit.request(
    "GET /repos/{owner}/{repo}/git/ref/{ref}",
    { ...common, ref: `heads/${branch}` }
  );
  if (ref.object.sha !== input.expectedDeployHead)
    refuse("maintenance_head_conflict");
  const { data: current } = await octokit.request(
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
    { ...common, commit_sha: input.expectedDeployHead }
  );
  const { data: root } = await octokit.request(
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
    { ...common, tree_sha: current.tree.sha }
  );
  if (root.truncated) refuse("maintenance_tree_incomplete");
  const directory = root.tree.find((e) => e.path === ".promote-state");
  if (
    !directory?.sha ||
    directory.type !== "tree" ||
    directory.mode !== "040000"
  )
    refuse("maintenance_marker_unproven");
  const { data: state } = await octokit.request(
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
    { ...common, tree_sha: directory.sha }
  );
  if (
    state.truncated ||
    state.tree.some((e) => e.path === "maintenance-drain-receipt.json")
  )
    refuse("maintenance_receipt_or_incomplete_tree");
  const file = state.tree.find((e) => e.path === "maintenance-drain.json");
  if (
    !file?.sha ||
    file.type !== "blob" ||
    file.mode !== "100644" ||
    file.size === undefined ||
    file.size > 65536
  )
    refuse("maintenance_marker_unproven");
  const { data: blob } = await octokit.request(
    "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
    { ...common, file_sha: file.sha }
  );
  if (
    blob.encoding !== "base64" ||
    typeof blob.size !== "number" ||
    blob.size > 65536
  )
    refuse("maintenance_marker_unproven");
  const bytes = Buffer.from(blob.content, "base64");
  if (
    bytes.length !== blob.size ||
    createHash("sha256").update(bytes).digest("hex") !==
      input.expectedMarkerSha256
  )
    refuse("maintenance_marker_hash_conflict");
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    refuse("maintenance_marker_invalid");
  }
  const parsed = markerSchema.safeParse(decoded);
  if (!parsed.success) refuse("maintenance_marker_invalid");
  const marker = parsed.data;
  if (
    marker.operationId !== input.operationId ||
    marker.request.nodeId !== input.nodeId ||
    marker.request.slug !== input.slug ||
    marker.request.sourceRepository.toLowerCase() !== source.toLowerCase() ||
    marker.phaseEvidence.nodeId !== input.nodeId
  )
    refuse("maintenance_marker_identity_mismatch");
  const { data: before } = await octokit.request(
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
    { ...common, commit_sha: marker.request.expected.deployCommit }
  );
  // Inventory is not a native process lock. Supported maintenance is read-only;
  // ordinary delivery retains the marker guard. A competing Git writer loses CAS.
  const inventory = async () => {
    for (const status of [
      "requested",
      "waiting",
      "pending",
      "queued",
      "in_progress",
      "action_required",
    ] as const) {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/actions/runs",
        { ...common, status, per_page: 100 }
      );
      if (data.total_count >= 100 || data.workflow_runs.length >= 100)
        refuse("maintenance_inventory_incomplete");
      for (const run of data.workflow_runs) {
        if (run.status === "completed") continue;
        // Only known non-mutating code checks are excluded. Unknown jobs may target this lane.
        const path = run.path?.split("@")[0];
        if (
          path &&
          /^\.github\/workflows\/(ci\.yaml|pr-build\.yml|codeql[^/]*\.ya?ml|deploy-ref-ancestry\.yml)$/.test(
            path
          )
        )
          continue;
        refuse("maintenance_delivery_active");
      }
    }
  };
  await inventory();
  const { data: deletion } = await octokit.request(
    "POST /repos/{owner}/{repo}/git/trees",
    {
      ...common,
      base_tree: current.tree.sha,
      tree: [
        {
          path: ".promote-state/maintenance-drain.json",
          mode: "100644",
          type: "blob",
          sha: null,
        },
      ],
    }
  );
  if (deletion.sha !== before.tree.sha)
    refuse("maintenance_runtime_tree_changed");
  const { data: commit } = await octokit.request(
    "POST /repos/{owner}/{repo}/git/commits",
    {
      ...common,
      tree: deletion.sha,
      parents: [input.expectedDeployHead],
      message: `chore(candidate-a): cancel unexecuted ${input.slug} maintenance\n\nOperation: ${input.operationId}\nPrevious-Head: ${input.expectedDeployHead}\nMarker-SHA256: ${input.expectedMarkerSha256}\nActor: ${input.actorId.replace(/[\r\n]/g, " ")}\nReason: ${input.reason.replace(/[\r\n]/g, " ")}`,
    }
  );
  await inventory();
  try {
    const { data: updated } = await octokit.request(
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}",
      { ...common, ref: `heads/${branch}`, sha: commit.sha, force: false }
    );
    if (updated.object.sha !== commit.sha)
      refuse("maintenance_update_unproven", 502);
  } catch (error) {
    if ([409, 422].includes((error as { status?: number }).status ?? 0))
      refuse("maintenance_head_conflict");
    throw error;
  }
  return {
    commitSha: commit.sha,
    previousHead: input.expectedDeployHead,
    treeSha: deletion.sha,
    branch,
    operationId: input.operationId,
  };
}
