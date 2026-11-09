// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/declarations.test`
 * Purpose: Prove that the operator's REAL checked-in canary workload manifest
 *   (`.cogni/workloads/canary.yaml`) resolves to its release spec for every environment, and that the
 *   resolver keeps the node-identity check and surfaces manifest refusals (task.5400, story.5137).
 *   The per-rule refusals and the byte-identical lowering are proven in packages/repo-spec/tests.
 * Side-effects: filesystem read of the root `.cogni/repo-spec.yaml` and `.cogni/workloads/canary.yaml`
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS,
  extractNodeServices,
  hasDeclaredNodeDeployment,
  parseRepoSpec,
  RETIRED_SECRET_REFS_MESSAGE,
} from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";
import {
  DeclarationError,
  hostForEnv,
  resolveWorkloadDeclaration,
} from "./declarations";
import { WORKLOAD_ZONE } from "./testing";

const NODE_ID = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../../../../..");
const ROOT_SPEC = readFileSync(
  path.join(ROOT, ".cogni/repo-spec.yaml"),
  "utf8"
);
const CANARY = {
  path: ".cogni/workloads/canary.yaml",
  text: readFileSync(path.join(ROOT, ".cogni/workloads/canary.yaml"), "utf8"),
};

const resolve = (
  over: Partial<Parameters<typeof resolveWorkloadDeclaration>[0]> = {}
) =>
  resolveWorkloadDeclaration({
    workloadZone: WORKLOAD_ZONE,
    nodeSlug: "operator",
    repoSpecText: ROOT_SPEC,
    manifests: [CANARY],
    nodeId: NODE_ID,
    env: "production",
    workload: "canary",
    ...over,
  });

describe("the operator's checked-in canary workload manifest", () => {
  it("repo-spec no longer declares workloads and is not an app-tier deployment", () => {
    const spec = parseRepoSpec(ROOT_SPEC);
    expect(hasDeclaredNodeDeployment(spec)).toBe(false);
    expect(extractNodeServices(spec).map((s) => s.name)).toEqual(["app"]);
  });

  it("canary-db: the dedicated postgres state, TLS on, 2Gi persistent, tcp 5432 global", () => {
    const w = resolve({ workload: "canary-db" });
    expect(w).toMatchObject({
      kind: "state",
      port: 5432,
      cpu: 0.5,
      memoryMi: 512,
      expose: { tcp: { global: true } },
      persistent: { sizeMi: 2048, mountPath: "/var/lib/postgresql/data" },
      exclusive: false,
    });
    expect(w.image).toMatch(/^postgres:16@sha256:[0-9a-f]{64}$/);
    expect(w.command?.join(" ")).toContain("ssl=on");
  });

  it("canary: port 8080 behind the route, bound to canary-db, health /version + /readyz", () => {
    const w = resolve();
    expect(w).toMatchObject({
      kind: "app",
      port: 8080,
      cpu: 0.25,
      memoryMi: 256,
      storageMi: 256,
      exclusive: false,
      bindings: [{ env: "DATABASE_URL", workload: "canary-db" }],
      health: { version: "/version", ready: "/readyz" },
    });
    expect(w.command?.[2]).toContain('("0.0.0.0", 8080)');
  });

  it("hosts follow the environment: production / -test / -preview / -dev", () => {
    const host = (env: string) => {
      const w = resolve({ env });
      return "http" in w.expose ? w.expose.http.host : undefined;
    };
    expect(host("production")).toBe("node-deploy-canary.cognidao.org");
    expect(host("candidate-a")).toBe("node-deploy-canary-test.cognidao.org");
    expect(host("preview")).toBe("node-deploy-canary-preview.cognidao.org");
    expect(host("dev")).toBe("node-deploy-canary-dev.cognidao.org");
    expect(() => hostForEnv("a.example.org", "mars")).toThrow(
      /unknown environment/
    );
  });

  it('refuses a manifest with cogni.dev/exclusive: "true" and returns the issue (CD6)', () => {
    const text = CANARY.text.replace(
      'cogni.dev/exclusive: "false"',
      'cogni.dev/exclusive: "true"'
    );
    expect(text).not.toBe(CANARY.text);
    expect(() => resolve({ manifests: [{ ...CANARY, text }] })).toThrow(
      expect.objectContaining({
        code: "workload_manifest_refused",
        issues: [
          expect.objectContaining({
            code: "exclusive_unsupported",
            file: CANARY.path,
          }),
        ],
      })
    );
  });

  it('an image of "." lowers to the supplied built image, and is refused without one (story.5127)', () => {
    const built = {
      ...CANARY,
      text: CANARY.text.replace(/^ {4}image: .*$/m, '    image: "."'),
    };
    expect(built.text).not.toBe(CANARY.text);
    const digest = `ghcr.io/cogni-dao/toks5@sha256:${"ab".repeat(32)}`;
    expect(resolve({ manifests: [built], builtImage: digest }).image).toBe(
      digest
    );
    expect(() => resolve({ manifests: [built] })).toThrow(
      expect.objectContaining({
        code: "workload_manifest_refused",
        issues: [expect.objectContaining({ code: "built_image_unresolved" })],
      })
    );
    // ALWAYS_DEFER (story.5137): the caller can defer the digest; the app is then pending on its tag
    const tag = `ghcr.io/cogni-dao/toks5:sha-${"a".repeat(40)}`;
    const pending = resolve({ manifests: [built], pendingImage: tag });
    expect(pending.image).toBe(tag);
    expect(pending.imagePending).toBe(true);
    // a digest, when supplied, wins over a deferred ref and the spec is not pending
    const pinned = resolve({
      manifests: [built],
      builtImage: digest,
      pendingImage: tag,
    });
    expect(pinned.image).toBe(digest);
    expect(pinned.imagePending).toBeUndefined();
  });

  it("refuses another node's id, an undeclared workload, no manifests and an unparseable repo-spec", () => {
    expect(() =>
      resolve({ nodeId: "00000000-0000-4000-8000-000000000001" })
    ).toThrow(expect.objectContaining({ code: "node_mismatch" }));
    expect(() => resolve({ workload: "nope" })).toThrow(
      expect.objectContaining({ code: "workload_not_declared" })
    );
    expect(() => resolve({ manifests: [] })).toThrow(
      expect.objectContaining({ code: "workload_not_declared" })
    );
    expect(() => resolve({ repoSpecText: "{{ not yaml" })).toThrow(
      DeclarationError
    );
  });
});

describe("declared secret keys on an app release (task.5405, bug.5254)", () => {
  /** A node catalog entry (`source: human`) that names the app service, so the key reaches the app. */
  const catalogFor = (keys: string[]) =>
    `secrets:\n${keys
      .map(
        (key) => `  - name: ${key}
    tier: A2
    source: human
    workloads: [app]
    required: true
    category: Node
    description: Node-owned key.
    steps: []
`
      )
      .join("")}`;
  const PROFILE = [...COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS];

  it("an app carries the profile keys; a state workload carries none", () => {
    expect(resolve().secretKeys).toEqual(PROFILE);
    expect(resolve({ workload: "canary-db" }).secretKeys).toBeUndefined();
  });

  it("a catalog key naming the app is added after the profile keys (poly's PAPER_ENFORCE_MODE)", () => {
    const w = resolve({
      secretsCatalogText: catalogFor(["PAPER_ENFORCE_MODE"]),
    });
    expect(w.secretKeys).toEqual([...PROFILE, "PAPER_ENFORCE_MODE"]);
    // a key merely present in some bucket is never listed: only declarations are
    expect(w.secretKeys).not.toContain("GH_WEBHOOK_SECRET");
  });

  it("refuses a catalog key that is an operator/fleet credential, naming the key", () => {
    for (const key of ["LITELLM_MASTER_KEY", "CLOUDFLARE_API_TOKEN"])
      expect(() => resolve({ secretsCatalogText: catalogFor([key]) })).toThrow(
        expect.objectContaining({
          code: "secrets_catalog_refused",
          message: expect.stringContaining(key),
        })
      );
  });

  it("refuses a repo-spec carrying secret_refs with the fixed catalog message (bug.5254)", () => {
    expect(() =>
      resolve({ repoSpecText: `${ROOT_SPEC}\nsecret_refs:\n  - key: X_KEY\n` })
    ).toThrow(
      expect.objectContaining({
        code: "secret_ref_refused",
        message: RETIRED_SECRET_REFS_MESSAGE,
      })
    );
  });
});
