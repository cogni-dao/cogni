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
import { parse, stringify } from "yaml";
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
  destinationAcceptedOverlayDir: join(dir, "overlay"),
  previewOverlayDir: join(dir, "overlay"),
  nodeId: spec.node_id,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "immutable-replay-"));
  // biome-ignore lint/style/noProcessEnv: isolate the fake ORAS executable for this test
  originalPath = process.env.PATH;
  // biome-ignore lint/style/noProcessEnv: isolate the fake ORAS executable for this test
  process.env.PATH = `${dir}:${originalPath}`;
  await writeFile(join(dir, "old.json"), JSON.stringify(payload));
  await writeFile(
    join(dir, "new.json"),
    JSON.stringify({
      ...payload,
      artifacts: payload.artifacts.map((artifact) => ({
        ...artifact,
        image: artifact.image.replace(
          /sha256:[0-9a-f]{64}$/,
          `sha256:${"9".repeat(64)}`
        ),
      })),
    })
  );
  await writeFile(
    join(dir, "oras"),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${dir}/calls'
case "$1" in
 resolve) echo '${newDigest}';;
 manifest) [ ! -f '${dir}/unavailable' ] || exit 1; printf '%s' '{"artifactType":"application/vnd.cogni.node-artifact-bundle.v1","layers":[{"mediaType":"application/vnd.cogni.node-artifact-bundle.v1+json","annotations":{"org.opencontainers.image.title":"node-artifact-bundle.json"}}]}';;
 pull) case "$4" in *'${oldDigest}') cp '${dir}/old.json' "$3/node-artifact-bundle.json";; *'${newDigest}') cp '${dir}/new.json' "$3/node-artifact-bundle.json";; *) exit 1;; esac;;
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

function manifest(generation: number) {
  return buildComputeWorkloadManifest({
    slug: "node",
    environment: "preview",
    bundleRef: `${repository}@${oldDigest}`,
    bundle: resolveNodeArtifactBundle(spec, payload, {
      sourceSha: sha,
      repository: "cogni-dao/node",
    }),
    publicHost: "node-preview.example.com",
    computeApi: "crossplane",
    leaseGeneration: generation,
  });
}
async function accepted(
  ref: unknown,
  sourceSha = sha,
  changes: Record<string, unknown> = {}
) {
  const original = manifest(5);
  await writeFile(
    join(dir, "overlay/xcomputeworkload.yaml"),
    stringify({
      ...original,
      ...changes,
      spec: {
        ...original.spec,
        ...((changes.spec as object) ?? {}),
        bundle: {
          ...original.spec.bundle,
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
    const repeated = await resolveBundleInput(input());
    expect(result).toEqual(repeated);
    expect(result.ref).toBe(`${repository}@${oldDigest}`);
    expect(await calls()).not.toContain("resolve ");
    const render = (value: typeof result) =>
      buildComputeWorkloadManifest({
        slug: "node",
        environment: "preview",
        bundleRef: value.ref,
        bundle: resolveNodeArtifactBundle(spec, value.payload, {
          sourceSha: sha,
          repository: "cogni-dao/node",
        }),
        publicHost: "node-preview.example.com",
        computeApi: "crossplane",
        leaseGeneration: 6,
      });
    const original = parse(
      await readFile(join(dir, "overlay/xcomputeworkload.yaml"), "utf8")
    ) as ReturnType<typeof manifest>;
    expect(render(result)).toEqual({
      ...original,
      spec: { ...original.spec, leaseGeneration: 6 },
    });
    expect(render(repeated)).toEqual(render(result));
    expect(render(result).spec.bundle.artifacts).toEqual(payload.artifacts);
  });
  it.each([
    { apiVersion: undefined },
    { apiVersion: "wrong" },
    { kind: undefined },
    { kind: "wrong" },
    { spec: { nodeId: undefined } },
    { spec: { nodeId: "wrong" } },
  ])("rejects invalid acceptance envelope before registry access: %j", async (changes) => {
    await accepted(`${repository}@${oldDigest}`, sha, changes);
    await expect(resolveBundleInput(input())).rejects.toThrow();
    await expect(calls()).rejects.toThrow();
  });
  it.each([
    "",
    "abc",
    "Z".repeat(40),
  ])("rejects malformed source SHA %s", async (badSha) => {
    await accepted(`${repository}@${oldDigest}`, badSha);
    await expect(resolveBundleInput(input())).rejects.toThrow();
    await expect(calls()).rejects.toThrow();
  });
  it("rejects malformed source repository before registry access", async () => {
    const original = manifest(5);
    await writeFile(
      join(dir, "overlay/xcomputeworkload.yaml"),
      stringify({
        ...original,
        spec: {
          ...original.spec,
          bundle: {
            ...original.spec.bundle,
            source: { repository: "bad repo", sha },
          },
        },
      })
    );
    await expect(resolveBundleInput(input())).rejects.toThrow();
    await expect(calls()).rejects.toThrow();
  });
  it("accepts the legacy workload kind", async () => {
    await accepted(`${repository}@${oldDigest}`, sha, {
      kind: "ComputeWorkload",
    });
    expect((await resolveBundleInput(input())).ref).toBe(
      `${repository}@${oldDigest}`
    );
  });
  it.each([
    "node identity",
    "artifact coverage",
  ])("retains payload validation for %s", async (failure) => {
    await accepted(`${repository}@${oldDigest}`);
    const invalid =
      failure === "node identity"
        ? { ...payload, node_id: "wrong" }
        : { ...payload, artifacts: payload.artifacts.slice(0, 1) };
    await writeFile(join(dir, "old.json"), JSON.stringify(invalid));
    const result = await resolveBundleInput(input());
    expect(() =>
      resolveNodeArtifactBundle(spec, result.payload, {
        sourceSha: sha,
        repository: "cogni-dao/node",
      })
    ).toThrow();
    expect(await calls()).not.toContain("resolve ");
  });
  it("requires matching preview acceptance before discovery", async () => {
    await expect(
      resolveBundleInput({ ...input(), previewForward: true })
    ).rejects.toThrow();
    await accepted(`${repository}@${oldDigest}`, "b".repeat(40));
    await expect(
      resolveBundleInput({ ...input(), previewForward: true })
    ).rejects.toThrow();
    await expect(calls()).rejects.toThrow();
  });
  it("selects preview acceptance instead of a different destination pin", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "destination"));
    await writeFile(
      join(dir, "destination/xcomputeworkload.yaml"),
      stringify({
        ...manifest(5),
        spec: {
          ...manifest(5).spec,
          bundle: {
            ...manifest(5).spec.bundle,
            ref: `${repository}@${newDigest}`,
          },
        },
      })
    );
    await accepted(`${repository}@${oldDigest}`);
    const paths = {
      ...input(),
      destinationAcceptedOverlayDir: join(dir, "destination"),
    };
    const preview = await resolveBundleInput({
      ...paths,
      previewForward: true,
    });
    const destination = await resolveBundleInput({
      ...paths,
      previewForward: false,
    });
    expect(preview.ref).toBe(`${repository}@${oldDigest}`);
    expect(preview.payload).toEqual(payload);
    expect(destination.ref).toBe(`${repository}@${newDigest}`);
    expect(destination.payload).not.toEqual(payload);
    expect(await calls()).not.toContain("resolve ");
    await rm(join(dir, "overlay/xcomputeworkload.yaml"));
    await expect(
      resolveBundleInput({ ...paths, previewForward: true })
    ).rejects.toThrow();
    await accepted(`${repository}@${oldDigest}`, "b".repeat(40));
    await expect(
      resolveBundleInput({ ...paths, previewForward: true })
    ).rejects.toThrow();
    expect(await calls()).not.toContain("resolve ");
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
      ...(mode === "candidate"
        ? {
            destinationAcceptedOverlayDir: undefined,
            previewOverlayDir: undefined,
          }
        : {}),
    });
    expect(result.ref).toBe(`${repository}@${newDigest}`);
    expect(result.payload).not.toEqual(payload);
    expect(await calls()).toContain("resolve ");
  });
});
