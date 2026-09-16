// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/akash-lane-compute-env-custody`
 * Purpose: Pins how an Akash lane hosted in the PRODUCTION cluster resolves the env values a paid lease is built from (story.5016 seam 5).
 *   Seam 4 made the lanes ADDRESSABLE; these assertions govern what they are allowed to READ
 *   once an XR lands in one.
 * Scope: Static YAML/text checks over the lane overlay, the Composition it serves and the per-node generator's output; does NOT contact a cluster, an OpenBao or a wallet.
 * Invariants:
 *   - PRODUCTION_CUSTODY_IS_READ_LOCALLY: any lane ExternalSecret resolving a `production/*` path
 *     must use the in-cluster store. Fetching a production-custody credential across a cluster
 *     boundary is the one direction that is never acceptable, under EITHER candidate design for
 *     the node-owned half (see docs/spec/secrets-management.md Invariant 1).
 *   - LANE_SELECTS_KEYS_NEVER_EXTRACTS: no lane ExternalSecret may `dataFrom: extract` a bucket.
 *     provider-http can name ANY key of ANY Secret in the XR's namespace, so a wholesale extract
 *     of the 50-key operator bucket would let a lane XR ship a production DSN to a third-party
 *     compute provider as a lease env var.
 *   - LANE_PROJECTS_EXACTLY_WHAT_THE_COMPOSITION_NAMES: every `operator-env-secrets:<ns>:KEY`
 *     the Composition emits is projected by every lane, and nothing else is. A placeholder with
 *     no key fails the WHOLE provider-http request, so a drifted set is a lease that mints and
 *     then cannot publish DNS.
 * Notes: the per-node `<slug>-compute-env-secrets` half is NOT resolvable yet and no assertion
 *   here claims otherwise — both candidate designs are blocked on a missing mechanism (env-local
 *   writes vs in-cluster-only reads). The generator's current emission is pinned as a change
 *   detector, deliberately NOT as an endorsement of either design.
 * Side-effects: IO (reads repo manifests)
 * Links: story.5016 seam 5, knowledge:akash-actuator-wallet-cutover, docs/spec/secrets-management.md
 * @public
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildComputeSecretResources } from "../../nodes/operator/app/src/features/compute/compute-workload-secret-manifests";

const REPO_ROOT = path.resolve(__dirname, "../..");
const LANE_DIR = path.join(
  REPO_ROOT,
  "infra/k8s/overlays/production/akash-lanes"
);
const COMPOSITION = path.join(
  REPO_ROOT,
  "infra/crossplane/xcomputeworkload/composition.yaml"
);

/** The lanes the production cluster hosts on behalf of other environments. */
const LANES = ["candidate-a", "preview"] as const;

type YamlObject = Record<string, unknown>;

const laneFiles = readdirSync(LANE_DIR)
  .filter((f) => f.endsWith(".yaml") && f !== "kustomization.yaml")
  .sort();

const laneDocs = laneFiles.map((file) => ({
  file,
  doc: parse(readFileSync(path.join(LANE_DIR, file), "utf8")) as YamlObject,
}));

const externalSecrets = laneDocs.filter(
  ({ doc }) => doc.kind === "ExternalSecret"
);

function spec(doc: YamlObject): YamlObject {
  return (doc.spec ?? {}) as YamlObject;
}

function meta(doc: YamlObject): YamlObject {
  return (doc.metadata ?? {}) as YamlObject;
}

/**
 * Every `operator-env-secrets:<ns>:KEY` placeholder the Composition builds from the XR's OWN
 * namespace. Read from the Composition rather than restated, so the two cannot drift.
 */
const compositionText = readFileSync(COMPOSITION, "utf8");
const operatorKeysNamedInXrNamespace = [
  ...new Set(
    [...compositionText.matchAll(/operator-env-secrets:%s:([A-Z_]+)/g)].map(
      (m) => m[1]
    )
  ),
].sort();

describe("akash lane compute-env custody", () => {
  it("names at least one operator key in the XR's own namespace", () => {
    // Guards the three assertions below from silently passing on an empty set if the
    // Composition ever stops using `%s`-formatted placeholders.
    expect(operatorKeysNamedInXrNamespace.length).toBeGreaterThan(0);
    expect(operatorKeysNamedInXrNamespace).toContain("CLOUDFLARE_API_TOKEN");
  });

  it("resolves every PRODUCTION-custody path through the in-cluster store", () => {
    // Scoped deliberately to `production/*` paths. This does NOT forbid a future lane-scoped
    // second store for `<env>/<slug>` node values — that is the open seam-5 question, and
    // pinning it here would prejudge it. What is NOT open in either direction: a production
    // credential must never be fetched across a cluster boundary.
    expect(externalSecrets.length).toBeGreaterThan(0);
    let productionPathSecrets = 0;
    for (const { file, doc } of externalSecrets) {
      const data = (spec(doc).data ?? []) as { remoteRef?: { key?: string } }[];
      if (!data.some((d) => d.remoteRef?.key?.startsWith("production/"))) {
        continue;
      }
      productionPathSecrets += 1;
      const ref = (spec(doc).secretStoreRef ?? {}) as YamlObject;
      expect(ref.kind, file).toBe("ClusterSecretStore");
      // `openbao-backend` is the canonical in-cluster store, installed identically in every
      // cluster, so it always resolves to the OpenBao of whichever cluster reconciles.
      expect(ref.name, file).toBe("openbao-backend");
    }
    expect(productionPathSecrets).toBeGreaterThan(0);
  });

  it("selects keys one by one and never extracts a whole bucket", () => {
    for (const { file, doc } of externalSecrets) {
      const s = spec(doc);
      // A lane Secret is nameable by provider-http from inside the lane, so its key set is a
      // capability grant. `dataFrom` makes that grant the whole OpenBao path.
      expect(s.dataFrom, file).toBeUndefined();
      const data = (s.data ?? []) as { remoteRef?: { property?: string } }[];
      expect(data.length, file).toBeGreaterThan(0);
      for (const entry of data) {
        expect(entry.remoteRef?.property, file).toBeTruthy();
      }
    }
  });

  it("projects exactly the operator keys the Composition dereferences, in every lane", () => {
    for (const lane of LANES) {
      const projection = externalSecrets.find(
        ({ doc }) =>
          meta(doc).name === "operator-env-secrets" &&
          meta(doc).namespace === `cogni-${lane}`
      );
      expect(projection, `cogni-${lane} operator-env-secrets`).toBeDefined();
      const s = spec(projection?.doc ?? {});
      // The target name is the literal string inside the placeholder — a wire contract.
      expect((s.target as YamlObject | undefined)?.name).toBe(
        "operator-env-secrets"
      );
      const projected = ((s.data ?? []) as { secretKey: string }[])
        .map((d) => d.secretKey)
        .sort();
      // Equality, not superset, in BOTH directions: a missing key fails the whole
      // provider-http request (a lease that mints and cannot publish DNS), and an extra key
      // widens the lane's reach into the production operator bucket for no caller.
      expect(projected).toEqual(operatorKeysNamedInXrNamespace);
    }
  });

  it("reads the operator keys from the PRODUCTION bucket, like the actuator bearer beside them", () => {
    // These are the PLATFORM's credentials, not the node's: one Cloudflare zone token and one
    // lease log-push credential serve every environment, exactly as one writer does. A
    // `<lane>/operator` path would resolve to nothing and imply a second operator per lane.
    for (const lane of LANES) {
      const projection = externalSecrets.find(
        ({ doc }) =>
          meta(doc).name === "operator-env-secrets" &&
          meta(doc).namespace === `cogni-${lane}`
      );
      const data = (spec(projection?.doc ?? {}).data ?? []) as {
        remoteRef?: { key?: string };
      }[];
      for (const entry of data) {
        expect(entry.remoteRef?.key, `cogni-${lane}`).toBe(
          "production/operator"
        );
      }
    }
  });

  it("holds NO per-node compute-env secret — the generator owns that, per node", () => {
    // Adding a node to a lane must stay a catalog change. A hand-written
    // `<slug>-compute-env-secrets` here would fork the generator's output and silently
    // out-rank it for exactly one node.
    for (const { file, doc } of laneDocs) {
      expect(String(meta(doc).name ?? ""), file).not.toMatch(
        /-compute-env-secrets$/
      );
    }
  });

  it("emits a per-node secret whose path names the ENVIRONMENT (change detector, not an endorsement)", () => {
    // The generator is the one thing both candidate designs must agree with, so its current
    // output is pinned HERE rather than argued about in a PR comment:
    //   - the remoteRef path `<env>/<slug>` is durable under BOTH designs. It names the
    //     environment; it has never named the cluster that custodies it.
    //   - the store name `openbao-backend` currently resolves to whichever OpenBao is local.
    //     If the lane ends up reading the pre-prod OpenBao through a second, lane-scoped store,
    //     THIS LINE is what must change, and this test is what forces that change to be
    //     deliberate instead of incidental.
    for (const lane of LANES) {
      const [projection] = buildComputeSecretResources({
        slug: "example-node",
        environment: lane,
        secretRefs: [{ key: "DATABASE_URL" }],
      });
      const doc = projection.manifest as YamlObject;
      expect(meta(doc).namespace).toBe(`cogni-${lane}`);
      const s = spec(doc);
      // Same cluster-scoped store the lane files use — resolves to whichever OpenBao is local.
      expect((s.secretStoreRef as YamlObject).name).toBe("openbao-backend");
      const data = (s.data ?? []) as { remoteRef: { key: string } }[];
      // The path names the ENVIRONMENT, and only the environment. WHICH OpenBao custodies that
      // path is the open question this seam did not get to close.
      expect(data[0].remoteRef.key).toBe(`${lane}/example-node`);
    }
  });
});
