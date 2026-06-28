// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

import { renderOverlay } from "@/shared/node-app-scaffold/gens/overlay";

// Mirrors the real node-template template overlay: node-at-root migrate paths (/app/app) + the ESO
// `<slug>-env-secrets` target carried directly. renderOverlay only slug/port-renames it.
const TEMPLATE = `namePrefix: node-template-
patches:
  - target:
      kind: Deployment
      name: node-app
    patch: |
      - op: replace
        path: /spec/template/spec/containers/0/envFrom/1/secretRef/name
        value: "node-template-env-secrets"
      - op: replace
        path: /spec/template/spec/initContainers/0/envFrom/1/secretRef/name
        value: "node-template-env-secrets"
      - op: replace
        path: /spec/template/spec/initContainers/0/command/2
        value: exec node /app/app/migrate.mjs /app/app/migrations
      - op: replace
        path: /spec/template/spec/containers/0/ports/0/containerPort
        value: 3200
      - op: add
        path: /spec/template/spec/initContainers/-
        value:
          name: migrate-doltgres
          command:
            - /bin/sh
            - -c
            - exec node /app/app/migrate-doltgres.mjs /app/app/doltgres-migrations
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: node-template-env-secrets
                  key: DOLTGRES_URL
  - target:
      kind: Service
      name: node-app
    patch: |
      - op: add
        path: /spec/ports/0/nodePort
        value: 30200
      - op: replace
        path: /spec/ports/0/targetPort
        value: 3200
`;

describe("renderOverlay", () => {
  it("renames the slug and the two well-known port literals", () => {
    const out = renderOverlay(TEMPLATE, "coulditbe", 30500, 3500);

    expect(out).toContain("namePrefix: coulditbe-");
    expect(out).toContain("value: 30500");
    expect(out).toContain("value: 3500");
    expect(out).not.toContain("node-template");
    expect(out).not.toContain("30200");
  });

  it("carries the ESO env-secrets target through unchanged (no secret rewrite)", () => {
    const out = renderOverlay(TEMPLATE, "coulditbe", 30500, 3500);

    expect(out).toContain('value: "coulditbe-env-secrets"');
    expect(out).toContain("name: coulditbe-env-secrets");
    expect(out).not.toContain("node-app-secrets");
  });

  it("preserves the node-at-root image layout for both migrate runners", () => {
    const out = renderOverlay(TEMPLATE, "coulditbe", 30500, 3500);

    expect(out).toContain(
      "value: exec node /app/app/migrate.mjs /app/app/migrations"
    );
    expect(out).toContain(
      "exec node /app/app/migrate-doltgres.mjs /app/app/doltgres-migrations"
    );
    expect(out).not.toContain("/app/nodes/");
  });

  it("fails closed when the node-at-root migrate command is absent", () => {
    const noMigrate = `namePrefix: node-template-
patches:
  - target:
      kind: Service
      name: node-app
    patch: |
      - op: add
        path: /spec/ports/0/nodePort
        value: 30200
`;
    expect(() => renderOverlay(noMigrate, "coulditbe", 30500, 3500)).toThrow(
      /NODE_AT_ROOT_MIGRATE_PATH/
    );
  });
});
