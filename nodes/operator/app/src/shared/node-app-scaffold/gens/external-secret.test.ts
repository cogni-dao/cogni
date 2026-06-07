// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/external-secret.test`
 * Purpose: Pin node-birth ExternalSecret rendering for formation PRs.
 * Scope: Pure renderer tests; does not read files or invoke Kubernetes.
 * Side-effects: none
 * Links: external-secret.ts, docs/spec/node-ci-cd-contract.md
 * @internal
 */

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  renderExternalSecret,
  renderExternalSecretKustomization,
} from "./external-secret";

describe("renderExternalSecret", () => {
  it("renders a per-env node-app secret leaf backed by the node OpenBao path", () => {
    const rendered = parseYaml(renderExternalSecret("creative", "candidate-a"));

    expect(rendered).toMatchObject({
      apiVersion: "external-secrets.io/v1",
      kind: "ExternalSecret",
      metadata: {
        name: "node-app-secrets",
        namespace: "cogni-candidate-a",
        labels: {
          "app.kubernetes.io/component": "creative",
        },
      },
      spec: {
        secretStoreRef: {
          name: "openbao-backend",
          kind: "ClusterSecretStore",
        },
        target: {
          name: "creative-node-app-secrets",
          creationPolicy: "Owner",
          deletionPolicy: "Retain",
        },
        dataFrom: [{ extract: { key: "candidate-a/creative" } }],
      },
    });
  });
});

describe("renderExternalSecretKustomization", () => {
  it("renders the leaf kustomization", () => {
    expect(parseYaml(renderExternalSecretKustomization())).toEqual({
      apiVersion: "kustomize.config.k8s.io/v1beta1",
      kind: "Kustomization",
      resources: ["external-secret.yaml"],
    });
  });
});
