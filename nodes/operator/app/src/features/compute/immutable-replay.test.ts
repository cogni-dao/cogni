// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNodeArtifactBundle,
  resolveNodeArtifactBundle,
} from "@cogni/repo-spec";
import { buildTestRepoSpec } from "@cogni/repo-spec/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { resolveBundleInput } from "../../../scripts/materialize-compute-workload";
import { buildComputeWorkloadManifest } from "./compute-workload-manifest";

const sha = "a".repeat(40);
const oldDigest = `sha256:${"1".repeat(64)}`;
const newDigest = `sha256:${"2".repeat(64)}`;
const repository = "ghcr.io/cogni-dao/node";
const spec = buildTestRepoSpec({
  deployment: {
    services: [
      {
        name: "app",
        artifact: { name: "app" },
        port: 3200,
        visibility: "public",
        resources: { cpu_units: 1, memory_mi: 2048, storage_mi: 4096 },
      },
      {
        name: "worker",
        artifact: { name: "worker", dockerfile: "services/worker/Dockerfile" },
        port: 9100,
        visibility: "private",
        resources: { cpu_units: 0.5, memory_mi: 1024, storage_mi: 2048 },
      },
    ],
  },
});
const payload = buildNodeArtifactBundle({
  spec,
  sourceSha: sha,
  repository: "cogni-dao/node",
  artifacts: [
    {
      artifact: "app",
      sourceSha: sha,
      image: `${repository}@sha256:${"3".repeat(64)}`,
    },
    {
      artifact: "worker",
      sourceSha: sha,
      image: `${repository}-worker@sha256:${"4".repeat(64)}`,
    },
  ],
});
let dir: string;
let originalPath: string | undefined;
const input = () => ({
  bundleFile: undefined,
  bundleRef: undefined,
  bundleRepository: repository,
  sourceRepository: "cogni-dao/node",
  sourceSha: sha,
  acceptedOverlayDir: join(dir, "overlay"),
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "immutable-replay-"));
  // biome-ignore lint/style/noProcessEnv: isolate the fake ORAS executable for this test
  originalPath = process.env.PATH;
  // biome-ignore lint/style/noProcessEnv: isolate the fake ORAS executable for this test
  process.env.PATH = `${dir}:${originalPath}`;
  await writeFile(join(dir, "payload.json"), JSON.stringify(payload));
  await writeFile(
    join(dir, "oras"),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${dir}/calls'
case "$1" in
 resolve) echo '${newDigest}';;
 manifest) [ ! -f '${dir}/unavailable' ] || exit 1; printf '%s' '{"artifactType":"application/vnd.cogni.node-artifact-bundle.v1","layers":[{"mediaType":"application/vnd.cogni.node-artifact-bundle.v1+json","annotations":{"org.opencontainers.image.title":"node-artifact-bundle.json"}}]}';;
 pull) cp '${dir}/payload.json' "$3/node-artifact-bundle.json";;
esac
`,
    { mode: 0o755 }
  );
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(join(dir, "overlay"))
  );
});
afterEach(async () => {
  // biome-ignore lint/style/noProcessEnv: restore the runner environment
  process.env.PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});

async function accepted(ref: unknown, sourceSha = sha) {
  await writeFile(
    join(dir, "overlay/xcomputeworkload.yaml"),
    stringify({
      spec: {
        bundle: {
          ref,
          source: { repository: "cogni-dao/node", sha: sourceSha },
        },
      },
    })
  );
}
async function calls() {
  return readFile(join(dir, "calls"), "utf8");
}

describe("immutable replay", () => {
  it("ignores the overwritten source tag and preserves the full spec across a generation change", async () => {
    await accepted(`${repository}@${oldDigest}`);
    const result = await resolveBundleInput(input());
    expect(result.ref).toBe(`${repository}@${oldDigest}`);
    expect(await calls()).not.toContain("resolve ");
    const resolved = resolveNodeArtifactBundle(spec, result.payload, {
      sourceSha: sha,
      repository: "cogni-dao/node",
    });
    const render = (generation: number) =>
      buildComputeWorkloadManifest({
        slug: "node",
        environment: "preview",
        bundleRef: result.ref,
        bundle: resolved,
        publicHost: "node-preview.example.com",
        computeApi: "crossplane",
        leaseGeneration: generation,
      });
    const five = render(5).spec;
    const six = render(6).spec;
    expect(six).toEqual({ ...five, leaseGeneration: 6 });
    expect(render(6).spec).toEqual(six);
    expect(six.bundle.artifacts).toEqual(payload.artifacts);
  });
  it.each([
    undefined,
    "bad",
    `${repository}@sha256:${"z".repeat(64)}`,
    `ghcr.io/other/node@${oldDigest}`,
  ])("rejects a missing or invalid selected ref without fallback: %s", async (ref) => {
    await accepted(ref);
    await expect(resolveBundleInput(input())).rejects.toThrow();
    await expect(calls()).rejects.toThrow();
  });
  it("refuses an unavailable accepted digest without resolving a tag", async () => {
    await accepted(`${repository}@${oldDigest}`);
    await writeFile(join(dir, "unavailable"), "");
    await expect(resolveBundleInput(input())).rejects.toThrow();
    expect(await calls()).not.toContain("resolve ");
  });
  it("rejects a malformed OCI manifest without resolving a tag", async () => {
    await accepted(`${repository}@${oldDigest}`);
    await writeFile(
      join(dir, "oras"),
      `#!/bin/sh
printf '%s\\n' "$*" >> '${dir}/calls'
echo '{}'
`,
      { mode: 0o755 }
    );
    await expect(resolveBundleInput(input())).rejects.toThrow();
    expect(await calls()).not.toContain("resolve ");
  });
  it.each([
    "initial",
    "new source",
    "candidate",
  ])("discovers a trusted bundle for %s", async (mode) => {
    if (mode === "new source")
      await accepted(`${repository}@${oldDigest}`, "b".repeat(40));
    const result = await resolveBundleInput({
      ...input(),
      ...(mode === "candidate" ? { acceptedOverlayDir: undefined } : {}),
    });
    expect(result.ref).toBe(`${repository}@${newDigest}`);
    expect(await calls()).toContain("resolve ");
  });
});
