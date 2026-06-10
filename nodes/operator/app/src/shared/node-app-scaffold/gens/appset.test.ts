// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/appset`
 * Purpose: Pin `renderNodeAppset` + `insertAppsetKustomization` to byte-exact cases mirroring
 *   `scripts/ci/render-node-appset.sh` (template sed-substitution + the GENERATED kustomization block).
 * Scope: Pure unit tests — goldens mirror the shell renderer's output so the operator's emit can't skew
 *   against the `pnpm gen:node-appset --check` drift gate.
 * Invariants: BYTE_EXACT_WITH_RENDERER — token substitution + env-major/node-sorted block ordering.
 * Side-effects: none
 * Links: src/shared/node-app-scaffold/gens/appset, scripts/ci/render-node-appset.sh
 * @public
 */

import { describe, expect, it } from "vitest";

import { insertAppsetKustomization, renderNodeAppset } from "./appset";

const ENVS = ["candidate-a", "preview", "production"] as const;

// Minimal template carrying both tokens + an Argo goTemplate marker that must survive untouched.
const TEMPLATE = `metadata:
  name: cogni-__ENV__-__NODE__
spec:
  generators:
    - git:
        revision: deploy/__ENV__-__NODE__
        files:
          - path: "infra/catalog/__NODE__.yaml"
  template:
    metadata:
      name: "__ENV__-{{.name}}"
`;

// A kustomization with the GENERATED block (canary/node-template/operator), plus surrounding
// context the splice must leave byte-identical.
const BEFORE = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - openbao-application.yaml
  # >>> GENERATED node-appsets (scripts/ci/render-node-appset.sh) — DO NOT EDIT BY HAND
  - candidate-a-canary-applicationset.yaml
  - candidate-a-node-template-applicationset.yaml
  - candidate-a-operator-applicationset.yaml
  - preview-canary-applicationset.yaml
  - preview-node-template-applicationset.yaml
  - preview-operator-applicationset.yaml
  - production-canary-applicationset.yaml
  - production-node-template-applicationset.yaml
  - production-operator-applicationset.yaml
  # <<< GENERATED node-appsets
`;

describe("renderNodeAppset", () => {
  it("substitutes __ENV__/__NODE__ globally and leaves {{.name}} intact", () => {
    expect(renderNodeAppset(TEMPLATE, "foo", "candidate-a")).toBe(
      `metadata:
  name: cogni-candidate-a-foo
spec:
  generators:
    - git:
        revision: deploy/candidate-a-foo
        files:
          - path: "infra/catalog/foo.yaml"
  template:
    metadata:
      name: "candidate-a-{{.name}}"
`
    );
  });
});

describe("insertAppsetKustomization", () => {
  it("folds the new slug into every env group in ASCII-sorted position", () => {
    // 'foo' sorts between 'canary' and 'node-template' in each of the three env groups.
    expect(insertAppsetKustomization(BEFORE, "foo", ENVS)).toBe(
      `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - openbao-application.yaml
  # >>> GENERATED node-appsets (scripts/ci/render-node-appset.sh) — DO NOT EDIT BY HAND
  - candidate-a-canary-applicationset.yaml
  - candidate-a-foo-applicationset.yaml
  - candidate-a-node-template-applicationset.yaml
  - candidate-a-operator-applicationset.yaml
  - preview-canary-applicationset.yaml
  - preview-foo-applicationset.yaml
  - preview-node-template-applicationset.yaml
  - preview-operator-applicationset.yaml
  - production-canary-applicationset.yaml
  - production-foo-applicationset.yaml
  - production-node-template-applicationset.yaml
  - production-operator-applicationset.yaml
  # <<< GENERATED node-appsets
`
    );
  });

  it("is idempotent when the slug is already listed", () => {
    const once = insertAppsetKustomization(BEFORE, "foo", ENVS);
    expect(insertAppsetKustomization(once, "foo", ENVS)).toBe(once);
  });

  it("throws when the sentinels are missing", () => {
    expect(() =>
      insertAppsetKustomization("resources:\n  - x.yaml\n", "foo", ENVS)
    ).toThrow(/sentinels/);
  });

  // task.5017 — per-env node-set. A node born into a subset of envs must be
  // added ONLY to those env blocks, and must NOT re-inflate the other envs'
  // members (the old union-then-cartesian bug). Here preview already carries a
  // smaller set (operator only); inserting `foo` for [candidate-a, production]
  // leaves preview untouched.
  it("adds a subset-born node only to its envs without re-inflating others", () => {
    const TRIMMED = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - openbao-application.yaml
  # >>> GENERATED node-appsets (scripts/ci/render-node-appset.sh) — DO NOT EDIT BY HAND
  - candidate-a-canary-applicationset.yaml
  - candidate-a-operator-applicationset.yaml
  - preview-operator-applicationset.yaml
  - production-canary-applicationset.yaml
  - production-operator-applicationset.yaml
  # <<< GENERATED node-appsets
`;
    expect(
      insertAppsetKustomization(TRIMMED, "foo", ["candidate-a", "production"])
    ).toBe(
      `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - openbao-application.yaml
  # >>> GENERATED node-appsets (scripts/ci/render-node-appset.sh) — DO NOT EDIT BY HAND
  - candidate-a-canary-applicationset.yaml
  - candidate-a-foo-applicationset.yaml
  - candidate-a-operator-applicationset.yaml
  - preview-operator-applicationset.yaml
  - production-canary-applicationset.yaml
  - production-foo-applicationset.yaml
  - production-operator-applicationset.yaml
  # <<< GENERATED node-appsets
`
    );
  });
});
