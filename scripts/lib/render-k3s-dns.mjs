// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@scripts/lib/render-k3s-dns`
 * Purpose: Render/check explicit catalog DNS resources in existing per-node overlays.
 * Scope: Committed catalog and owned DNS files. Does not contact providers or access credentials.
 * Invariants: Canonical absent intent is inert; template DNS references never clone to other nodes.
 * Side-effects: IO (catalog reads and deterministic generated files).
 * Links: bug.5526, isolated-k3s-workload-dns
 * @internal
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildK3sDnsRequest,
  k3sDnsIntent,
  projectK3sDnsOverlay,
  stripK3sDnsProjection,
} from "../../nodes/operator/app/src/shared/node-app-scaffold/gens/k3s-dns.ts";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const mode = process.argv[2];
const selected = process.argv[3];
const preflight = mode === "--preflight";
if (!["--write", "--check", "--preflight"].includes(mode))
  throw new Error("Expected --write or --check");
const file = "k3s-dns-request.json";
const jsonYaml = (p) =>
  JSON.parse(
    execFileSync("yq", ["-o=json", ".", p], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  );
let repository = process.env.GITHUB_REPOSITORY;
function repo() {
  if (!repository) {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const match =
      /^(?:https:\/\/github.com\/|git@github.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
        remote
      );
    if (!match) throw new Error("DNS repository identity required");
    repository = match[1];
  }
  return repository;
}
const verifyOrWrite = (p, body) => {
  if (mode === "--write") {
    writeFileSync(p, body);
    return;
  }
  if (!existsSync(p) || readFileSync(p, "utf8") !== body)
    throw new Error(`DNS generated drift: ${path.relative(root, p)}`);
};
for (const name of readdirSync(path.join(root, "infra/catalog")).filter((n) =>
  n.endsWith(".yaml")
)) {
  const catalog = jsonYaml(path.join(root, "infra/catalog", name));
  if (preflight && catalog.name !== selected) continue;
  for (const environment of ["candidate-a", "preview", "production"]) {
    const intent = k3sDnsIntent(catalog, environment);
    if (
      preflight &&
      environment !== (process.env.DEPLOY_ENVIRONMENT ?? "candidate-a")
    )
      continue;
    if (preflight && !intent) {
      textNoIntent();
      continue;
    }
    const dir = path.join(
      root,
      "infra/k8s/overlays",
      environment,
      catalog.name
    );
    const overlay = path.join(dir, "kustomization.yaml");
    const output = path.join(dir, file);
    if (!intent) {
      if (existsSync(output)) {
        const previous = JSON.parse(readFileSync(output, "utf8"));
        const owner = previous.metadata?.annotations?.["cogni.io/dns-owner"];
        if (
          previous.kind !== "Request" ||
          previous.metadata?.name !== "workload-dns" ||
          !owner?.startsWith(`cogni:${repo()}:`) ||
          !owner.endsWith(`:${environment}`)
        )
          throw new Error("DNS generated file owner mismatch");
        if (mode === "--check")
          throw new Error(
            `DNS resource without catalog intent: ${catalog.name}/${environment}`
          );
        rmSync(output);
        const text = readFileSync(overlay, "utf8");
        writeFileSync(overlay, stripK3sDnsProjection(text));
      }
      if (
        existsSync(overlay) &&
        readFileSync(overlay, "utf8") !==
          stripK3sDnsProjection(readFileSync(overlay, "utf8"))
      )
        throw new Error("DNS projection without owned generated resource");
      continue;
    }
    if (!existsSync(overlay)) throw new Error("DNS overlay is not deployed");
    const specPath = path.join(
      root,
      catalog.path_prefix ?? `nodes/${catalog.name}/`,
      ".cogni/repo-spec.yaml"
    );
    const nodeId = existsSync(specPath)
      ? jsonYaml(specPath).node_id
      : catalog.node_id;
    const substrateRoot = process.env.FORK_DOMAIN_ROOT ?? "cognidao.org";
    const defaultControl =
      environment === "production"
        ? substrateRoot
        : `${environment === "candidate-a" ? "test" : "preview"}.${substrateRoot}`;
    const controlDomain = preflight
      ? (process.env.CONTROL_DOMAIN ?? defaultControl)
      : defaultControl;
    const resource = buildK3sDnsRequest({
      catalog,
      environment,
      repository: repo(),
      nodeId,
      controlDomain,
      workloadDomain: preflight
        ? (process.env.DOMAIN ?? "")
        : intent.workloadDomain,
      substrateRoot,
    });
    if (preflight) {
      if (
        !existsSync(output) ||
        readFileSync(output, "utf8") !==
          `${JSON.stringify(resource, null, 2)}\n`
      )
        throw new Error("DNS runtime/committed projection differs");
      console.log(
        JSON.stringify({
          node: catalog.name,
          environment,
          repository: repo(),
          nodeId,
          zoneId: intent.zoneId,
          target: intent.target,
          host: JSON.parse(resource.spec.forProvider.payload.body).name,
          owner: resource.metadata.annotations["cogni.io/dns-owner"],
        })
      );
      continue;
    }
    verifyOrWrite(output, `${JSON.stringify(resource, null, 2)}\n`);
    const text = readFileSync(overlay, "utf8");
    const host = JSON.parse(resource.spec.forProvider.payload.body).name;
    verifyOrWrite(overlay, projectK3sDnsOverlay(text, host));
  }
}

function textNoIntent() {
  console.log("null");
}
