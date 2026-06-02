// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/node-app-scaffold/gens/scheduler-endpoints`
 * Purpose: Pin `insertSchedulerEndpoint` to a byte-exact before→after configmap.yaml case.
 * Scope: Pure unit test — the golden mirrors `pnpm gen:scheduler-worker-endpoints` output after
 *   scaffolding `ztest` (node_id 8138ed59-…) into the catalog.
 * Invariants: NODE_TARGETS == slug-lexicographic; per node a `<slug>=<url>` cell immediately
 *   trailed by its `<node_id>=<url>` alias; committed 2-space indent + double-quoted value.
 * Side-effects: none
 * Links: src/features/node-app-scaffold/gens/scheduler-endpoints, scripts/ci/render-scheduler-worker-endpoints.sh
 * @public
 */

import { describe, expect, it } from "vitest";

import { insertSchedulerEndpoint } from "./scheduler-endpoints";

// The committed `infra/k8s/base/scheduler-worker/configmap.yaml` (origin/main): canary,
// node-template, operator, resy — each with its slug entry + node_id alias.
const BEFORE = `# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Non-secret configuration for scheduler-worker.
apiVersion: v1
kind: ConfigMap
metadata:
  name: scheduler-worker-config
data:
  TEMPORAL_ADDRESS: "temporal:7233"
  # Per-node API endpoints — identical across envs (k8s Service DNS + port).
  COGNI_NODE_ENDPOINTS: "canary=http://canary-node-app:3000,89612f02-114d-460d-87a5-c2ab212ccf6f=http://canary-node-app:3000,node-template=http://node-template-node-app:3000,b927a9dd-6132-4fc9-a51e-e3cee2568e3c=http://node-template-node-app:3000,operator=http://operator-node-app:3000,4ff8eac1-4eba-4ed0-931b-b1fe4f64713d=http://operator-node-app:3000,resy=http://resy-node-app:3000,f6d2a17d-b7f6-4ad1-a86b-f0ad2380999e=http://resy-node-app:3000"
  LOG_LEVEL: "info"
`;

// `pnpm gen:scheduler-worker-endpoints` after `scaffold-node.sh ztest 3200 31999 8138ed59-…`:
// ztest sorts after resy, so its pair appends last.
const NODE_ID = "8138ed59-d955-4b30-9bae-7d754bac6e4e";
const GOLDEN = BEFORE.replace(
  'f6d2a17d-b7f6-4ad1-a86b-f0ad2380999e=http://resy-node-app:3000"',
  `f6d2a17d-b7f6-4ad1-a86b-f0ad2380999e=http://resy-node-app:3000,ztest=http://ztest-node-app:3000,${NODE_ID}=http://ztest-node-app:3000"`
);

describe("insertSchedulerEndpoint", () => {
  it("appends a node that sorts last, byte-exact to the catalog regen", () => {
    expect(insertSchedulerEndpoint(BEFORE, "ztest", NODE_ID)).toBe(GOLDEN);
  });

  it("splices a node into its slug-sorted position (before resy)", () => {
    const out = insertSchedulerEndpoint(
      BEFORE,
      "operator-mid",
      "11111111-2222-3333-4444-555555555555"
    );
    // `operator-mid` sorts between `operator` and `resy`.
    expect(out).toContain(
      "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d=http://operator-node-app:3000,operator-mid=http://operator-mid-node-app:3000,11111111-2222-3333-4444-555555555555=http://operator-mid-node-app:3000,resy=http://resy-node-app:3000"
    );
  });

  it("rejects a node already present", () => {
    expect(() => insertSchedulerEndpoint(BEFORE, "canary", NODE_ID)).toThrow(
      /already contains/
    );
  });

  it("throws when the configmap has no endpoints line", () => {
    expect(() =>
      insertSchedulerEndpoint('data:\n  LOG_LEVEL: "info"\n', "ztest", NODE_ID)
    ).toThrow(/missing a quoted/);
  });
});
