#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/ops/maintenance-drain`
 * Purpose: Inventory owning-node candidate producers before maintenance cutover.
 * Scope: Existing runner-owned maintenance delivery; does not replace allocation or database authority.
 * Invariants: Exact source and custody; no inferred absence or retained-cell deletion.
 * Side-effects: IO (read-only owning runner ledger, Kubernetes and delivery inventory).
 * Links: story.5095, task.5281
 * @internal
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const requireThat = (condition, code) => {
  if (!condition) throw new Error(code);
};
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  }).trim();
const sha = (value) => createHash("sha256").update(value).digest("hex");

export function closed(detail) {
  // A Console404 is ambiguous about custody. Require positive independently read state.
  return (
    detail?.deployment?.state === "closed" &&
    Array.isArray(detail.leases) &&
    detail.leases.length > 0 &&
    detail.leases.every((lease) => lease.state === "closed") &&
    detail.escrow_account?.state?.state === "closed"
  );
}

/** Remove only the historical app XR from desired state; preserve migration-secret custody. */
export function inertCandidateKustomization(text) {
  const value = parseYaml(text);
  requireThat(
    value?.namespace === "cogni-candidate-a" &&
      Object.keys(value).every((key) =>
        ["apiVersion", "kind", "namespace", "resources", "metadata"].includes(
          key
        )
      ),
    "maintenance_candidate_kustomization_entrypoint_unproven"
  );
  const custody = [
    "compute-env-external-secret.yaml",
    "compute-env-secret-role.yaml",
    "compute-env-secret-role-binding.yaml",
  ];
  requireThat(
    value?.kind === "Kustomization" && Array.isArray(value.resources),
    "maintenance_candidate_kustomization_unproven"
  );
  requireThat(
    value.resources.length === 4 &&
      new Set(value.resources).size === 4 &&
      value.resources.includes("xcomputeworkload.yaml") &&
      custody.every((name) => value.resources.includes(name)),
    "maintenance_candidate_desired_shape_changed"
  );
  // These exact resources are the observed historical8b506 shape. No unknown producer kind survives.
  const next = text.replace(
    /^([ \t]*)-[ \t]+xcomputeworkload\.yaml[ \t]*(?:#.*)?\r?\n/m,
    ""
  );
  requireThat(
    next !== text &&
      JSON.stringify(parseYaml(next).resources) ===
        JSON.stringify(
          value.resources.filter((name) => name !== "xcomputeworkload.yaml")
        ),
    "maintenance_candidate_inert_projection_failed"
  );
  return next;
}

/** Positive complete inventory is mandatory even when the caller expects no app receipts. */
export function assertEmptyCandidateInventory(rows, request) {
  requireThat(
    Array.isArray(rows) && rows.length < 100,
    "maintenance_receipt_inventory_unknown"
  );
  requireThat(
    request.env === "candidate-a" &&
      request.slug === "node-template" &&
      Array.isArray(request.expected.receipts) &&
      request.expected.receipts.length === 0,
    "maintenance_candidate_empty_scope_mismatch"
  );
  requireThat(
    rows.every(
      (row) => row.node_id === request.nodeId && row.environment === request.env
    ),
    "maintenance_candidate_receipt_scope_mismatch"
  );
  // The initial isolated gate does not close or reinterpret historical application allocations.
  // A single app/preparing/history row must use the separately reviewed owning close contract.
  const protectedIds = new Set(
    (request.protectedCells ?? []).map((cell) => cell.receiptId)
  );
  requireThat(
    rows.every((row) => row.state !== "preparing" && protectedIds.has(row.id)),
    "maintenance_candidate_old_receipt_requires_close"
  );
}

export function namespaceAbsent(status, body) {
  return status === 404 && body === "kube: lease not found\n";
}

/** Positive typed server-cell identity is the sole exclusion from app-producer closure. */
export function protectedDatabaseCells(rows, request, metadataSchema) {
  const cells = [];
  for (const row of rows) {
    if (row.applied_database_cell_binding == null) continue;
    const metadata = metadataSchema.parse(row.applied_database_cell_binding);
    const retained =
      metadata.retentionPolicy === "retain" || metadata.bindings.length > 0;
    if (!retained) continue;
    requireThat(
      !request.expected.receipts.some(
        (item) => item.receiptId === row.id || item.cogniKey === row.cogni_key
      ),
      "maintenance_retained_storage_refused"
    );
    requireThat(
      row.workload === `${request.slug}-database-cell` &&
        metadata.bindings.some(
          ({ binding }) =>
            binding.phase === "applied" &&
            binding.receiptId === row.id &&
            binding.cogniKey === row.cogni_key &&
            binding.nodeId === request.nodeId &&
            binding.nodeSlug === request.slug &&
            binding.environment === request.env &&
            binding.dseq === row.external_name &&
            binding.providerAccount === row.provider_account
        ),
      "maintenance_retained_cell_identity_unproven"
    );
    cells.push({
      receiptId: row.id,
      cogniKey: row.cogni_key,
      dseq: row.external_name,
      providerAccount: row.provider_account,
      workload: row.workload,
      metadataSha256: sha(JSON.stringify(row.applied_database_cell_binding)),
    });
  }
  return cells;
}

/** Inventory all nonterminal jobs, including approval waits and pending concurrency holders. */
export function assertNoOldRuns(runs, currentRun) {
  requireThat(
    Array.isArray(runs) && runs.length < 100,
    "maintenance_delivery_inventory_incomplete"
  );
  requireThat(
    runs.every((item) => item.id === currentRun || item.status === "completed"),
    "maintenance_old_delivery_runs_present"
  );
}

export function deliveryRunMayTarget(workflow, run, slug, env) {
  // These two workflows only publish candidate-a app desired state; infra never promotes apps.
  if (workflow === "candidate-flight-infra.yml") return false;
  if (workflow === "candidate-flight.yml") return env === "candidate-a";
  const title = run.display_title?.split("·").map((part) => part.trim());
  if (
    title?.[0] === "Promote & Deploy" &&
    ["preview", "production"].includes(title[2])
  ) {
    if (title[2] !== env) return false;
    return (
      title[1] === "all-nodes" ||
      title[1]
        .split(",")
        .map((part) => part.trim())
        .includes(slug)
    );
  }
  return true; // An old/unidentifiable possibly-targeting run is not silently excluded.
}

async function deliveryInventory(request) {
  for (const repository of [
    "cogni-dao/cogni",
    "cogni-test-org/cogni-monorepo",
  ]) {
    for (const workflow of [
      "candidate-flight.yml",
      "candidate-flight-infra.yml",
      "promote-and-deploy.yml",
    ]) {
      for (const status of [
        "requested",
        "waiting",
        "pending",
        "queued",
        "in_progress",
      ]) {
        // Never infer empty from a failed read or a truncated page.
        const data = JSON.parse(
          run("gh", [
            "api",
            `repos/${repository}/actions/workflows/${workflow}/runs?per_page=100&status=${status}`,
          ])
        );
        requireThat(
          Array.isArray(data.workflow_runs) && data.workflow_runs.length < 100,
          "maintenance_delivery_inventory_incomplete"
        );
        const relevant = data.workflow_runs.filter((item) =>
          deliveryRunMayTarget(workflow, item, request.slug, request.env)
        );
        assertNoOldRuns(relevant, Number(process.env.GITHUB_RUN_ID));
      }
    }
  }
}

/** A truthful durable floor replaces the one-time empty-runtime bootstrap gate. */
export async function verifyAuditedCandidateAdmission(
  receipt,
  cluster,
  request,
  verifySource
) {
  requireThat(
    receipt?.request?.nodeId === request.nodeId &&
      receipt.request.slug === "node-template" &&
      receipt.request.env === "candidate-a" &&
      request.slug === "node-template" &&
      request.env === "candidate-a" &&
      receipt.request.sourceRepository === "cogni-dao/node-template",
    "maintenance_candidate_floor_scope_mismatch"
  );
  requireThat(
    Array.isArray(cluster.xrs) &&
      cluster.xrs.length <= 1 &&
      Array.isArray(cluster.producers) &&
      cluster.producers.length === 0 &&
      cluster.xrs.every(
        (xr) =>
          typeof xr.uid === "string" &&
          /^[a-f0-9]{40}$/.test(xr.bundleSource ?? "")
      ),
    "maintenance_candidate_live_source_unproven"
  );
  // Validate both the proposed source and the already-running compatible source.
  // Absence is not a substitute for the merged-MAIN/native-audit floor.
  for (const source of new Set([
    request.sourceSha,
    ...cluster.xrs.map((xr) => xr.bundleSource),
  ])) {
    await verifySource(receipt, source);
  }
}

function githubJson(path, allowAbsent = false) {
  try {
    return JSON.parse(run("gh", ["api", path]));
  } catch (error) {
    if (allowAbsent) {
      let response;
      try {
        response = JSON.parse(String(error?.stdout ?? ""));
      } catch {
        /* An unreadable response is never absence. */
      }
      if (response?.status === "404" && response.message === "Not Found")
        return null;
    }
    throw new Error("maintenance_delivery_inventory_unavailable");
  }
}

/** Read both guard files from one immutable deployment commit, never a moving ref. */
function candidateDeliveryAdmission() {
  const repository = "cogni-dao/cogni";
  const branch = "deploy/candidate-a-node-template";
  const ref = githubJson(`repos/${repository}/git/ref/heads/${branch}`);
  const head = ref?.object?.sha;
  requireThat(
    /^[a-f0-9]{40}$/.test(head ?? ""),
    "maintenance_deploy_head_unproven"
  );
  const read = (name) => {
    const value = githubJson(
      `repos/${repository}/contents/.promote-state/${name}?ref=${head}`,
      true
    );
    if (value === null) return null;
    requireThat(
      value.type === "file" &&
        value.encoding === "base64" &&
        value.size <= 65536,
      "maintenance_guard_file_unproven"
    );
    const data = JSON.parse(Buffer.from(value.content, "base64").toString());
    requireThat(
      data && !Array.isArray(data) && typeof data === "object",
      "maintenance_guard_shape_invalid"
    );
    return data;
  };
  const marker = read("maintenance-drain.json");
  requireThat(
    marker === null || marker.phase === "qualifying",
    "maintenance_drain_active"
  );
  return {
    head,
    marker,
    receipt: read("maintenance-drain-receipt.json"),
    read,
  };
}

function verifyCandidateQualification(admission, request, cluster) {
  const program = `import importlib.util,json,sys\ns=importlib.util.spec_from_file_location("fence",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\ng=m.check_qualification(json.load(sys.stdin),"cogni-dao/node-template",sys.argv[2],require_owner=False)\nassert m.compare_source("cogni-dao/cogni",g["activationHead"],sys.argv[3]) in ("ahead","identical"), "maintenance_qualification_lineage_changed"\n`;
  run(
    "python3",
    [
      "-c",
      program,
      `${process.env.CI_SOURCE_ROOT}/scripts/ci/lib/maintenance-fence.py`,
      request.sourceSha,
      admission.head,
    ],
    { input: JSON.stringify(admission.marker) }
  );
  const manifest = githubJson(
    `repos/cogni-dao/cogni/contents/infra/k8s/overlays/candidate-a/node-template/xcomputeworkload.yaml?ref=${admission.head}`
  );
  const value = parseYaml(
    Buffer.from(manifest.content ?? "", "base64").toString()
  );
  const bundle = value?.spec?.bundle;
  requireThat(
    manifest.type === "file" &&
      manifest.encoding === "base64" &&
      sha(Buffer.from(manifest.content, "base64")) ===
        admission.marker.qualification.manifestSha256 &&
      value.kind === "XComputeWorkload" &&
      value.metadata?.namespace === "cogni-candidate-a" &&
      value.spec?.nodeId === request.nodeId &&
      value.spec?.environment === request.env &&
      bundle?.source?.repository === "cogni-dao/node-template" &&
      bundle.source.sha === request.sourceSha &&
      bundle.ref === admission.marker.qualification.bundleDigest &&
      bundle.artifacts?.length === 1 &&
      bundle.artifacts[0].image ===
        admission.marker.qualification.imageDigest &&
      cluster.producers.length === 0 &&
      cluster.xrs.length <= 1 &&
      cluster.xrs.every(
        (xr) => xr.bundleSource === request.sourceSha && xr.uid
      ),
    "maintenance_qualification_artifact_mismatch"
  );
}

function verifyCandidateSourceFloor(receipt, source) {
  // Reuse exactly the deployed guard's MAIN-ancestry and source-compatibility check.
  const program = `import importlib.util,json,sys\ns=importlib.util.spec_from_file_location("fence",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nm.check_receipt(json.load(sys.stdin),sys.argv[2],sys.argv[3])\n`;
  run(
    "python3",
    [
      "-c",
      program,
      `${process.env.CI_SOURCE_ROOT}/scripts/ci/lib/maintenance-fence.py`,
      "cogni-dao/node-template",
      source,
    ],
    { input: JSON.stringify(receipt) }
  );
}

/** Read-only complete ledger snapshot inside the existing owning actuator pod. */
async function providerDrain(request) {
  const { readFileSync: read } = await import("node:fs");
  const { default: postgres } = await import("postgres");
  requireThat(
    request.phase === "inventory",
    "maintenance_read_only_phase_required"
  );
  requireThat(
    typeof process.env.AKASH_ACTUATOR_ACCOUNT_ID === "string" &&
      process.env.AKASH_ACTUATOR_ACCOUNT_ID.length > 0,
    "maintenance_wallet_identity_unavailable"
  );
  const sql = postgres(
    read("/var/run/secrets/akash-tx/DATABASE_URL", "utf8").trim(),
    { max: 1, connect_timeout: 10 }
  );
  try {
    const walletScope = `akash-console:${process.env.AKASH_ACTUATOR_ACCOUNT_ID}`;
    const rows =
      await sql`SELECT id, cogni_key, node_id, environment, workload, external_name, provider_account, state, applied_database_cell_binding FROM akash_tx_allocations WHERE wallet_scope = ${walletScope} AND node_id = ${request.nodeId} AND environment = ${request.env} LIMIT 100`;
    requireThat(rows.length < 100, "maintenance_receipt_inventory_unknown");
    return { rows, walletScope };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function candidateSnapshotCommand(request) {
  const namespace = `cogni-${request.env}`;
  const command = `set -euo pipefail
umask 077
probe=$(mktemp -d)
trap 'rm -rf "$probe"' EXIT
exec 3>&2
exec 2>"$probe/native.stderr"
phase=engine_inventory
trap 'rc=$?; printf "MAINTENANCE_NATIVE_PHASE phase=%s native_rc=%s\\n" "$phase" "$rc" >&3' ERR
python3 - '${JSON.stringify(request.expectedEngineImages)}' <<'PY_ENGINES'
import json,subprocess,sys
expected=json.loads(sys.argv[1]); engines=[]
def docker(args):
 result=subprocess.run(["timeout","20","docker",*args],capture_output=True,text=True)
 if result.returncode:
  print("MAINTENANCE_NATIVE_PHASE phase=engine_inventory native_rc="+str(result.returncode),file=sys.stderr)
  sys.exit(result.returncode)
 return result.stdout
for service in ("postgres","doltgres"):
 ids=docker(["ps","-aq","--no-trunc","--filter","label=com.docker.compose.project=cogni-runtime","--filter","label=com.docker.compose.service="+service]).split()
 assert len(ids)==1, "maintenance_engine_ownership_ambiguous"
 template='{"id":{{json .Id}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"startedAt":{{json .State.StartedAt}},"restartCount":{{json .RestartCount}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"workingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}}}'
 row=json.loads(docker(["inspect","--format",template,ids[0]]))
 assert row["id"]==ids[0] and len(row["id"])==64 and all(c in "0123456789abcdef" for c in row["id"])
 assert row["project"]=="cogni-runtime" and row["service"]==service and row["workingDir"]=="/opt/cogni-template-runtime", "maintenance_engine_custody_mismatch"
 assert row["image"]==expected[service] and len(row["imageId"])==71 and row["imageId"].startswith("sha256:") and all(c in "0123456789abcdef" for c in row["imageId"][7:]) and row["running"] is True and isinstance(row["restartCount"],int) and row["startedAt"], "maintenance_engine_identity_unproven"
 engines.append(row)
print("MAINTENANCE_ENGINE_IDENTITY "+json.dumps({"engines":engines}))
PY_ENGINES
phase=compute_api
timeout 20 kubectl api-resources --api-group=compute.cogni.io -o name > "$probe/compute-resources"
python3 - "$probe" <<'PY_KINDS'
import pathlib,sys
root=pathlib.Path(sys.argv[1]); kinds=root.joinpath("compute-resources").read_text().splitlines()
known={"computeworkloads.compute.cogni.io","xcomputeworkloads.compute.cogni.io"}
selected=[name for name in kinds if name in known]
assert selected, "maintenance_compute_api_inventory_unavailable"
root.joinpath("selected-kinds").write_text("\\n".join(selected)+"\\n")
PY_KINDS
while IFS= read -r kind; do
 phase=compute_objects
 timeout 20 kubectl -n '${namespace}' get "$kind" -o json > "$probe/$kind"
done < "$probe/selected-kinds"
phase=producer_objects
timeout 20 kubectl -n '${namespace}' get deployments,replicasets,statefulsets,pods,jobs,cronjobs -o json > "$probe/producers"
phase=applications
timeout 20 kubectl -n argocd get applications.argoproj.io -o json > "$probe/apps"
phase=application_sets
timeout 20 kubectl -n argocd get applicationsets.argoproj.io -o json > "$probe/appsets"
phase=cluster_parse
python3 - '${request.nodeId}' '${request.slug}' "$probe" <<'PY_SNAPSHOT'
import json,sys,datetime
node,slug,root=sys.argv[1:]
def read(name):
 value=json.load(open(root+"/"+name)); assert isinstance(value.get("items"),list); return value["items"]
def owned(value):
 meta=value.get("metadata",{});labels=meta.get("labels",{});spec=value.get("spec",{})
 return spec.get("nodeId")==node or labels.get("cogni.io/node-id")==node or labels.get("cogni.io/node")==slug or meta.get("name","")==slug or meta.get("name","").startswith(slug+"-")
def source_identity(value):
 return {key:value[key] for key in ["repoURL","path","targetRevision","chart"] if key in value} if value else None
def identity(value):
 meta=value.get("metadata",{});spec=value.get("spec",{});status=value.get("status",{})
 return {"kind":value.get("kind"),"name":meta.get("name"),"uid":meta.get("uid"),"generation":meta.get("generation"),"observedGeneration":status.get("observedGeneration"),"deleting":meta.get("deletionTimestamp") is not None,"instance":spec.get("instance"),"workload":spec.get("workload",{}).get("name"),"bundleSource":spec.get("bundle",{}).get("source",{}).get("sha")}
xrs=[]
for name in open(root+"/selected-kinds").read().splitlines():
 xrs.extend(read(name))
apps=[]
for value in read("apps"):
 sources=value.get("spec",{}).get("sources") or [value.get("spec",{}).get("source",{})]
 if any(item.get("targetRevision")=="deploy/candidate-a-"+slug for item in sources):
  apps.append({"name":value["metadata"]["name"],"revision":value.get("status",{}).get("sync",{}).get("revision"),"sync":value.get("status",{}).get("sync",{}).get("status"),"health":value.get("status",{}).get("health",{}).get("status"),"automated":value.get("spec",{}).get("syncPolicy",{}).get("automated"),"owners":value.get("metadata",{}).get("ownerReferences",[])})
print(json.dumps({"observedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),"xrs":[identity(v) for v in xrs if owned(v)],"producers":[identity(v) for v in read("producers") if owned(v)],"applications":apps,"applicationSets":[{"name":v["metadata"]["name"],"uid":v["metadata"]["uid"],"generation":v["metadata"].get("generation"),"templateSource":source_identity(v.get("spec",{}).get("template",{}).get("spec",{}).get("source")),"templateSources":[source_identity(item) for item in v.get("spec",{}).get("template",{}).get("spec",{}).get("sources",[])],"destination":v.get("spec",{}).get("template",{}).get("spec",{}).get("destination"),"syncPolicy":v.get("spec",{}).get("template",{}).get("spec",{}).get("syncPolicy"),"generatorKinds":[list(g.keys()) for g in v.get("spec",{}).get("generators",[])]} for v in read("appsets")]}))
PY_SNAPSHOT
`;
  return command;
}

export function parseCandidateSnapshotOutput(stdout, expectedImages) {
  const lines = stdout.trim().split("\n");
  const receipts = lines.filter((line) =>
    line.startsWith("MAINTENANCE_ENGINE_IDENTITY ")
  );
  requireThat(receipts.length === 1, "maintenance_engine_receipt_unavailable");
  const receipt = JSON.parse(
    receipts[0].slice("MAINTENANCE_ENGINE_IDENTITY ".length)
  );
  requireThat(
    Array.isArray(receipt.engines) && receipt.engines.length === 2,
    "maintenance_engine_receipt_unavailable"
  );
  const fields = [
    "id",
    "image",
    "imageId",
    "startedAt",
    "restartCount",
    "running",
    "project",
    "service",
    "workingDir",
  ];
  requireThat(
    Object.keys(receipt).length === 1 && Object.hasOwn(receipt, "engines"),
    "maintenance_engine_receipt_unproven"
  );
  const services = new Set();
  const ids = new Set();
  for (const row of receipt.engines) {
    requireThat(
      row &&
        typeof row === "object" &&
        Object.keys(row).length === fields.length &&
        Object.keys(row).every((field) => fields.includes(field)),
      "maintenance_engine_receipt_unproven"
    );
    requireThat(
      ["postgres", "doltgres"].includes(row.service) &&
        !services.has(row.service) &&
        !ids.has(row.id) &&
        /^[0-9a-f]{64}$/.test(row.id) &&
        /^sha256:[0-9a-f]{64}$/.test(row.imageId) &&
        row.running === true &&
        row.project === "cogni-runtime" &&
        row.workingDir === "/opt/cogni-template-runtime" &&
        Number.isInteger(row.restartCount) &&
        row.restartCount >= 0 &&
        typeof row.startedAt === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          row.startedAt
        ) &&
        Number.isFinite(Date.parse(row.startedAt)) &&
        typeof expectedImages?.[row.service] === "string" &&
        row.image === expectedImages[row.service],
      "maintenance_engine_receipt_unproven"
    );
    services.add(row.service);
    ids.add(row.id);
  }
  console.log("MAINTENANCE_ENGINE_IDENTITY", JSON.stringify(receipt));
  return JSON.parse(
    lines
      .filter((line) => !line.startsWith("MAINTENANCE_ENGINE_IDENTITY "))
      .join("\n")
  );
}

function reportNativePhase(error, fallback) {
  const allowed =
    /MAINTENANCE_NATIVE_PHASE phase=(engine_inventory|compute_api|compute_objects|producer_objects|applications|application_sets|cluster_parse) native_rc=([0-9]{1,3})(?:\n|$)/g;
  const matches = [...String(error?.stderr ?? "").matchAll(allowed)];
  for (const match of matches)
    console.error(
      `MAINTENANCE_NATIVE_PHASE phase=${match[1]} native_rc=${match[2]}`
    );
  console.error(
    "MAINTENANCE_NATIVE_PHASE",
    JSON.stringify({
      phase: fallback,
      native_rc: Number.isInteger(error?.status) ? error.status : null,
    })
  );
}

function candidateClusterSnapshot(request) {
  let stdout;
  try {
    stdout = run(
      "ssh",
      [
        "-i",
        `${process.env.HOME}/.ssh/deploy_key`,
        "-o",
        "StrictHostKeyChecking=accept-new",
        `root@${process.env.VM_HOST}`,
        "bash",
        "-s",
      ],
      { input: candidateSnapshotCommand(request) }
    );
  } catch (error) {
    // Even a later Kubernetes read failure must retain the earlier native engine receipt.
    const receipts = String(error?.stdout ?? "")
      .split("\n")
      .filter((line) => line.startsWith("MAINTENANCE_ENGINE_IDENTITY "));
    if (receipts.length === 1) {
      try {
        parseCandidateSnapshotOutput(
          `${receipts[0]}\n{}`,
          request.expectedEngineImages
        );
      } catch {
        /* Failed identity is never accepted. */
      }
    }
    reportNativePhase(error, "cluster_ssh");
    throw new Error("maintenance_native_phase_unavailable");
  }
  try {
    return parseCandidateSnapshotOutput(stdout, request.expectedEngineImages);
  } catch (error) {
    reportNativePhase(error, "cluster_output");
    throw new Error("maintenance_native_phase_unavailable");
  }
}

/** First owning-runner proof is read-only and precedes all desired-state/credential changes. */
async function candidateReadOnlyPreflight() {
  requireThat(
    process.env.GITHUB_REPOSITORY?.toLowerCase() === "cogni-dao/cogni" &&
      process.env.NODE === "node-template" &&
      process.env.CONTROL_ENV === "production",
    "maintenance_candidate_owner_scope_mismatch"
  );
  const catalog = parseYaml(
    readFileSync(
      `${process.env.APP_SOURCE_ROOT}/infra/catalog/node-template.yaml`,
      "utf8"
    )
  );
  requireThat(
    /^[0-9a-f-]{36}$/.test(catalog.node_id ?? "") &&
      /^[0-9a-f]{40}$/.test(catalog.source_sha ?? "") &&
      catalog.envs?.includes("candidate-a") &&
      catalog.deployment_provider?.["candidate-a"] === "akash",
    "maintenance_candidate_catalog_identity_unproven"
  );
  const request = {
    env: "candidate-a",
    slug: "node-template",
    nodeId: catalog.node_id,
    sourceSha: process.env.NODE_SOURCE_SHA || catalog.source_sha,
    expected: { receipts: [] },
  };
  requireThat(
    /^[a-f0-9]{40}$/.test(request.sourceSha),
    "maintenance_candidate_source_unproven"
  );
  const admission = candidateDeliveryAdmission();
  const compose = parseYaml(
    readFileSync(
      `${process.env.CI_SOURCE_ROOT}/infra/compose/runtime/docker-compose.yml`,
      "utf8"
    )
  );
  request.expectedEngineImages = Object.fromEntries(
    ["postgres", "doltgres"].map((service) => {
      const image = compose?.services?.[service]?.image;
      requireThat(
        typeof image === "string" &&
          /^[a-zA-Z0-9][a-zA-Z0-9./:@_-]{1,255}$/.test(image),
        "maintenance_engine_declared_image_unproven"
      );
      return [service, image];
    })
  );
  let inventory;
  try {
    inventory = remoteProvider({ ...request, phase: "inventory" });
  } catch (error) {
    reportNativePhase(error, "ledger_inventory");
    throw new Error("maintenance_native_phase_unavailable");
  }
  console.log(
    "MAINTENANCE_CANDIDATE_LEDGER",
    JSON.stringify({
      nodeId: request.nodeId,
      environment: request.env,
      sourceSha: request.sourceSha,
      complete: true,
      walletScope: inventory.walletScope,
      rows: inventory.rows.map((row) => ({
        receiptId: row.id,
        cogniKey: row.cogni_key,
        nodeId: row.node_id,
        environment: row.environment,
        workload: row.workload,
        dseq: row.external_name,
        providerAccount: row.provider_account,
        state: row.state,
        databaseCellMetadataSha256:
          row.applied_database_cell_binding == null
            ? null
            : sha(JSON.stringify(row.applied_database_cell_binding)),
      })),
    })
  );
  let DatabaseCellAllocationMetadataSchema;
  try {
    ({ DatabaseCellAllocationMetadataSchema } = await import(
      pathToFileURL(
        `${process.env.CI_SOURCE_ROOT}/nodes/operator/app/src/shared/secrets/database-cell-placement.data.ts`
      ).href
    ));
  } catch (error) {
    reportNativePhase(error, "metadata_import");
    throw new Error("maintenance_native_phase_unavailable");
  }
  try {
    request.protectedCells = protectedDatabaseCells(
      inventory.rows,
      request,
      DatabaseCellAllocationMetadataSchema
    );
  } catch (error) {
    reportNativePhase(error, "protected_metadata");
    throw error;
  }
  const cluster = candidateClusterSnapshot(request);
  // Emit only typed, value-free evidence. Failed/closed/preparing history remains visible.
  console.log(
    "MAINTENANCE_CANDIDATE_PREFLIGHT",
    JSON.stringify({
      nodeId: request.nodeId,
      environment: request.env,
      controlEnvironment: process.env.CONTROL_ENV,
      walletScope: inventory.walletScope,
      sourceSha: request.sourceSha,
      cluster,
      ledger: inventory.rows.map((row) => ({
        receiptId: row.id,
        cogniKey: row.cogni_key,
        nodeId: row.node_id,
        environment: row.environment,
        workload: row.workload,
        dseq: row.external_name,
        providerAccount: row.provider_account,
        state: row.state,
        databaseCellMetadataSha256:
          row.applied_database_cell_binding == null
            ? null
            : sha(JSON.stringify(row.applied_database_cell_binding)),
      })),
      protectedCells: request.protectedCells,
    })
  );
  if (admission.marker !== null) {
    verifyCandidateQualification(admission, request, cluster);
    console.log(
      "MAINTENANCE_CANDIDATE_ADMISSION",
      JSON.stringify({
        mode: "qualifying-active",
        head: admission.head,
        sourceSha: request.sourceSha,
        operationId: admission.marker.operationId,
      })
    );
    return;
  }
  if (admission.receipt !== null) {
    await verifyAuditedCandidateAdmission(
      admission.receipt,
      cluster,
      request,
      verifyCandidateSourceFloor
    );
    console.log(
      "MAINTENANCE_CANDIDATE_ADMISSION",
      JSON.stringify({
        mode: "audited",
        head: admission.head,
        sourceSha: request.sourceSha,
        operationId: admission.receipt.operationId,
      })
    );
    return;
  }
  assertEmptyCandidateInventory(inventory.rows, request);
  requireThat(
    cluster.xrs.length === 0 && cluster.producers.length === 0,
    "maintenance_candidate_old_live_producer_requires_close"
  );
  try {
    await deliveryInventory(request);
  } catch (error) {
    reportNativePhase(error, "delivery_inventory");
    throw error;
  }
  // Historical watched desired state is still active until the reviewed prospective fence is synced.
  // This first read-only gate cannot authorize materialization from an empty runtime observation alone.
  requireThat(
    false,
    "maintenance_candidate_prospective_source_fence_not_yet_proven"
  );
}

function remoteProvider(request) {
  const code = `const requireThat=${requireThat.toString()};\n${closed.toString()}\n${namespaceAbsent.toString()}\nconst providerDrain=${providerDrain.toString()};\nproviderDrain(JSON.parse(Buffer.from(process.argv[2],"base64").toString())).then(x=>console.log(JSON.stringify(x))).catch(()=>{console.error("maintenance_provider_gate_failed");process.exit(1)});`;
  const payload = Buffer.from(JSON.stringify(request)).toString("base64");
  const encoded = Buffer.from(code).toString("base64");
  const namespace = `cogni-${process.env.CONTROL_ENV}`;
  const command = `set -euo pipefail\npod=$(timeout 20 kubectl -n '${namespace}' get pods -l app.kubernetes.io/name=akash-tx-actuator -o json | python3 -c 'import json,sys; rows=json.load(sys.stdin)["items"]; assert len(rows)==1; p=rows[0]; assert p["status"]["phase"]=="Running" and not p["metadata"].get("deletionTimestamp") and any(c["type"]=="Ready" and c["status"]=="True" for c in p["status"].get("conditions",[])); print(p["metadata"]["name"])')\ntest -n "$pod"\nprintf '%s' '${encoded}' | base64 -d | timeout 90 kubectl -n '${namespace}' exec -i "$pod" -- node --input-type=module - '${payload}'\n`;
  return JSON.parse(
    run(
      "ssh",
      [
        "-i",
        `${process.env.HOME}/.ssh/deploy_key`,
        "-o",
        "StrictHostKeyChecking=accept-new",
        `root@${process.env.VM_HOST}`,
        "bash",
        "-s",
      ],
      { input: command }
    )
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  (async () => {
    requireThat(
      process.argv[2] === "candidate-preflight",
      "maintenance_read_only_phase_required"
    );
    await candidateReadOnlyPreflight();
  })().catch((error) => {
    const code = /^maintenance_[a-z0-9_]+$/.test(error?.message ?? "")
      ? error.message
      : "maintenance_native_phase_unavailable";
    console.error(code);
    process.exitCode = 1;
  });
