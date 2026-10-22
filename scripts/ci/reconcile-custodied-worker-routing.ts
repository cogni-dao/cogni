// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/ci/reconcile-custodied-worker-routing`
 * Purpose: Publish approved candidate queues to the worker that custodies them.
 * Scope: Protected-main inventory; one field in an existing worker deploy ref. Does not access clusters or promote images.
 * Invariants: NO_IMAGE_PROMOTION, NO_FOREIGN_REPOSITORY, PRESERVE_OTHER_ROUTES.
 * Side-effects: IO (GitHub Contents compare-and-set and CI receipts)
 * Links: https://cognidao.org/knowledge/lane-queue-follows-custody, spike.5010
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "yaml";
import { z } from "zod";

const Env = z.enum(["candidate-a", "preview", "production"]);
const Catalog = z.object({
  type: z.string(),
  name: z.string(),
  node_id: z.string().uuid().optional(),
  envs: z.array(Env).optional(),
  deployment_provider: z.record(z.string(), z.string()).optional(),
});
type CatalogRow = z.infer<typeof Catalog>;
const FIELD = "TEMPORAL_CUSTODIED_NODE_ENDPOINTS";
const NAMESPACE = "cogni-candidate-a";
const Patch = z.object({
  kind: z.literal("ConfigMap"),
  metadata: z.object({ name: z.literal("scheduler-worker-config") }),
  data: z.record(z.string(), z.string()),
});

function candidateNodes(catalogs: readonly CatalogRow[]): CatalogRow[] {
  return catalogs.filter(
    (row) =>
      row.type === "node" &&
      row.envs?.includes("candidate-a") &&
      row.deployment_provider?.["candidate-a"] === "akash"
  );
}

function routes(csv: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const pair of csv ? csv.split(",") : []) {
    const separator = pair.indexOf("=");
    if (separator < 1) throw new Error("invalid custodied endpoint");
    const key = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("custodied routes require credential-free HTTPS");
    }
    if (result.has(key)) throw new Error("duplicate custodied identity");
    result.set(key, value);
  }
  return result;
}

function custodyMap(text: string): Record<string, string> {
  const document = Patch.parse(yaml.parse(text));
  return z
    .record(z.string(), z.string())
    .parse(JSON.parse(document.data[FIELD] ?? "{}"));
}

/** Same custody rule as control_env_for: an explicitly Akash-placed foreign lane. */
export function approvedCandidateRoutes(
  catalogs: readonly CatalogRow[],
  fleetControlEnv: string,
  controlPatch: string
): { controlEnv: string; csv: string } | undefined {
  const controlEnv = Env.parse(fleetControlEnv);
  if (controlEnv === "candidate-a") return undefined;
  const nodes = candidateNodes(catalogs);
  if (nodes.length === 0) return undefined;
  const desired = routes(custodyMap(controlPatch)[NAMESPACE] ?? "");
  const expected = new Set<string>();
  for (const node of nodes) {
    if (!node.node_id) throw new Error("custodied node is missing its UUID");
    expected.add(node.name);
    expected.add(node.node_id);
    if (
      !desired.has(node.name) ||
      desired.get(node.name) !== desired.get(node.node_id)
    ) {
      throw new Error(
        "protected-main custody routes do not match catalog identities"
      );
    }
  }
  if (
    desired.size !== expected.size ||
    [...desired.keys()].some((key) => !expected.has(key))
  ) {
    throw new Error(
      "protected-main custody routes contain an unregistered node"
    );
  }
  return {
    controlEnv,
    csv: [...desired].map(([key, url]) => `${key}=${url}`).join(","),
  };
}

/** Add approved aliases; never remove/repoint another selection or rewrite other YAML. */
export function addCustodiedCandidateRoutes(
  current: string,
  approved: string
): string {
  const desired = routes(approved);
  const map = custodyMap(current);
  const existing = routes(map[NAMESPACE] ?? "");
  let changed = false;
  for (const [key, url] of desired) {
    if (existing.has(key) && existing.get(key) !== url) {
      throw new Error(`custodied route collision for ${key}`);
    }
    if (!existing.has(key)) {
      existing.set(key, url);
      changed = true;
    }
  }
  if (!changed) return current;
  map[NAMESPACE] = [...existing].map(([key, url]) => `${key}=${url}`).join(",");
  const lines = [
    ...current.matchAll(/^ {2}TEMPORAL_CUSTODIED_NODE_ENDPOINTS:.*$/gm),
  ];
  if (lines.length !== 1)
    throw new Error("expected exactly one single-line custody field");
  const replacement = `  ${FIELD}: '${JSON.stringify(map).replaceAll("'", "''")}'`;
  const next = current.replace(
    /^ {2}TEMPORAL_CUSTODIED_NODE_ENDPOINTS:.*$/m,
    () => replacement
  );
  if (custodyMap(next)[NAMESPACE] !== map[NAMESPACE])
    throw new Error("custody patch round-trip failed");
  return next;
}

const Contents = z.object({
  sha: z.string(),
  content: z.string(),
  encoding: z.literal("base64"),
});
type GitHubRequest = (
  method: string,
  endpoint: string,
  body?: unknown
) => Promise<unknown>;

/** Contents SHA is the CAS: concurrent file writers must be re-read, never force-pushed. */
export async function publishCustodiedRoutes(
  api: GitHubRequest,
  controlEnv: string,
  approved: string
): Promise<{ changed: boolean; deploySha: string }> {
  const env = Env.parse(controlEnv);
  if (env === "candidate-a")
    throw new Error("candidate-local custody needs no foreign writer");
  const branch = `deploy/${env}-scheduler-worker`;
  const file = `infra/k8s/overlays/${env}/scheduler-worker/node-endpoints.patch.yaml`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = z
      .object({ object: z.object({ sha: z.string() }) })
      .parse(await api("GET", `git/ref/heads/${branch}`));
    const source = Contents.parse(
      await api("GET", `contents/${file}?ref=${ref.object.sha}`)
    );
    const current = Buffer.from(source.content, "base64").toString("utf8");
    const next = addCustodiedCandidateRoutes(current, approved);
    if (next === current) return { changed: false, deploySha: ref.object.sha };
    try {
      const result = z.object({ commit: z.object({ sha: z.string() }) }).parse(
        await api("PUT", `contents/${file}`, {
          branch,
          sha: source.sha,
          content: Buffer.from(next).toString("base64"),
          message:
            "chore(candidate-a): register approved custodied worker queues",
        })
      );
      return { changed: true, deploySha: result.commit.sha };
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (attempt === 2 || (status !== 409 && status !== 422)) throw error;
    }
  }
  throw new Error("custodied routing CAS retries exhausted");
}

async function main(): Promise<void> {
  const authority = process.env.AUTHORITY_ROOT;
  if (!authority) throw new Error("AUTHORITY_ROOT is required");
  const fleet = Env.parse(process.env.FLEET_CONTROL_ENV || "production");
  const catalogs = readdirSync(path.join(authority, "infra/catalog"))
    .filter((file) => file.endsWith(".yaml") && !file.startsWith("_"))
    .map((file) =>
      Catalog.parse(
        yaml.parse(
          readFileSync(path.join(authority, "infra/catalog", file), "utf8")
        )
      )
    );
  const patch =
    fleet === "candidate-a" || candidateNodes(catalogs).length === 0
      ? ""
      : readFileSync(
          path.join(
            authority,
            `infra/k8s/overlays/${fleet}/scheduler-worker/node-endpoints.patch.yaml`
          ),
          "utf8"
        );
  const plan = approvedCandidateRoutes(catalogs, fleet, patch);
  const authoritySha = execFileSync(
    "git",
    ["-C", authority, "rev-parse", "HEAD"],
    { encoding: "utf8" }
  ).trim();
  if (process.argv.includes("--plan")) {
    if (!process.env.GITHUB_OUTPUT)
      throw new Error("GITHUB_OUTPUT is required");
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `custodian_worker_envs=${JSON.stringify(plan ? [plan.controlEnv] : [])}\ncustodian_authority_sha=${authoritySha}\n`
    );
    console.log(
      JSON.stringify({
        event: "custodied_worker_routing_planned",
        authoritySha,
        controlEnv: plan?.controlEnv ?? null,
      })
    );
    return;
  }
  if (!plan || plan.controlEnv !== process.env.CONTROL_ENV)
    throw new Error("custodian does not match protected-main plan");
  const repo = z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .parse(process.env.GITHUB_REPOSITORY);
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("GH_TOKEN is required");
  const api: GitHubRequest = async (method, endpoint, body) => {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/${endpoint}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      }
    );
    if (!response.ok)
      throw Object.assign(
        new Error(`GitHub custody transaction HTTP ${response.status}`),
        { status: response.status }
      );
    return response.json();
  };
  const result = await publishCustodiedRoutes(api, plan.controlEnv, plan.csv);
  const receipt = {
    event: "custodied_worker_routing_reconciled",
    namespace: NAMESPACE,
    controlEnv: plan.controlEnv,
    authoritySha,
    repository: repo,
    ...result,
  };
  console.log(JSON.stringify(receipt));
  if (process.env.CUSTODY_RECEIPT_FILE)
    writeFileSync(
      process.env.CUSTODY_RECEIPT_FILE,
      `${JSON.stringify(receipt)}\n`
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "custody routing failed"
    );
    process.exitCode = 1;
  });
}
