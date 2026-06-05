// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

import { renderOverlay } from "./overlay";

describe("renderOverlay", () => {
  it("inherits the ESO Secret name from node-template overlays", () => {
    const template = `patches:
  - patch: |
      - op: replace
        path: /spec/template/spec/containers/0/envFrom/1/secretRef/name
        value: "node-template-env-secrets"
images:
  - name: cogni-node-template
    newName: ghcr.io/cogni-dao/cogni-node-template
service:
  port: 3200
  nodePort: 30200
`;

    expect(renderOverlay(template, "acme", 3410, 3210)).toContain(
      'value: "acme-env-secrets"'
    );
    expect(renderOverlay(template, "acme", 3410, 3210)).not.toContain(
      "node-app-secrets"
    );
  });
});
