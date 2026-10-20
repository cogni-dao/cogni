// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/maintenance-drain`
 * Purpose: Exercise complete candidate inventory and protected-cell identity boundaries.
 * Scope: Local pure functions; does not access Git, network or cluster.
 * Invariants: Caller-empty receipts cannot hide old producers or retained app bindings.
 * Side-effects: none
 * Links: scripts/ops/maintenance-drain.mjs
 * @public
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { DatabaseCellAllocationMetadataSchema } from "@/shared/secrets/database-cell-placement.data";

const root = path.resolve(__dirname, "../..");
const modulePath = pathToFileURL(
  path.join(root, "scripts/ops/maintenance-drain.mjs")
).href;
const ops = await import(modulePath);

describe("maintenance drain proof boundary", () => {
  it("compiles the actual read-only runner snapshot programs", () => {
    const command = ops.candidateSnapshotCommand({
      env: "candidate-a",
      slug: "node-template",
      nodeId: "owned-node",
    });
    const scripts = [...command.matchAll(/<<'(PY_[A-Z]+)'\n([\s\S]*?)\n\1/g)];
    expect(scripts).toHaveLength(2);
    for (const [, , source] of scripts) {
      execFileSync(
        "python3",
        ["-c", "import ast,sys; ast.parse(sys.stdin.read())"],
        { input: source, timeout: 5000 }
      );
    }
    execFileSync("bash", ["-n"], { input: command, timeout: 5000 });
  });

  it("fences the historical XR only and preserves its exact secret/RBAC projection", () => {
    const text = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: cogni-candidate-a
resources:
  - xcomputeworkload.yaml
  - compute-env-external-secret.yaml
  - compute-env-secret-role.yaml
  - compute-env-secret-role-binding.yaml
`;
    for (const entrypoint of [
      "components",
      "bases",
      "patches",
      "configMapGenerator",
    ]) {
      expect(() =>
        ops.inertCandidateKustomization(`${text}${entrypoint}: []\n`)
      ).toThrow(/entrypoint_unproven/);
    }
    expect(ops.inertCandidateKustomization(text)).toBe(
      text.replace("  - xcomputeworkload.yaml\n", "")
    );
    expect(() =>
      ops.inertCandidateKustomization(
        text.replace("compute-env-secret-role.yaml", "deployment.yaml")
      )
    ).toThrow(/desired_shape/);
    expect(() =>
      ops.inertCandidateKustomization(`${text}  - database-cell.yaml\n`)
    ).toThrow(/desired_shape/);
  });

  it("requires complete positive candidate inventory rather than an empty caller list", () => {
    const request = {
      env: "candidate-a",
      slug: "node-template",
      nodeId: "owned-node",
      expected: { receipts: [] },
    };
    expect(() => ops.assertEmptyCandidateInventory([], request)).not.toThrow();
    for (const state of ["preparing", "allocated", "failed", "closed"]) {
      expect(() =>
        ops.assertEmptyCandidateInventory(
          [
            {
              id: "old-app",
              node_id: request.nodeId,
              environment: request.env,
              state,
            },
          ],
          request
        )
      ).toThrow(/old_receipt_requires_close/);
    }
    expect(() => ops.assertEmptyCandidateInventory(null, request)).toThrow(
      /inventory_unknown/
    );
    expect(() =>
      ops.assertEmptyCandidateInventory(
        [{ node_id: "foreign", environment: request.env }],
        request
      )
    ).toThrow(/scope_mismatch/);
    const cell = {
      id: "retained-cell",
      node_id: request.nodeId,
      environment: request.env,
      state: "allocated",
    };
    expect(() =>
      ops.assertEmptyCandidateInventory([cell], {
        ...request,
        protectedCells: [{ receiptId: cell.id }],
      })
    ).not.toThrow();
  });

  it("requires the exact namespace lookup terminal response", () => {
    expect(ops.namespaceAbsent(404, "kube: lease not found\n")).toBe(true);
    for (const [status, body] of [
      [404, ""],
      [404, "kube: no manifest for lease\n"],
      [404, "kube: no deployments for lease\n"],
      [403, "kube: lease not found\n"],
      [503, ""],
    ]) {
      expect(ops.namespaceAbsent(status, body)).toBe(false);
    }
  });

  it("requires positive closed financial state and every lease closed", () => {
    const value = {
      deployment: { state: "closed" },
      leases: [{ state: "closed" }],
      escrow_account: { state: { state: "closed" } },
    };
    expect(ops.closed(value)).toBe(true);
    expect(ops.closed({ ...value, leases: [] })).toBe(false);
    expect(
      ops.closed({ ...value, leases: [...value.leases, { state: "active" }] })
    ).toBe(false);
    expect(ops.closed({ ...value, escrow_account: null })).toBe(false);
    expect(ops.closed(null)).toBe(false);
  });

  it("does not turn another node's promotion into a fleet lock", () => {
    const run = { display_title: "Promote & Deploy · red · production · sha" };
    expect(
      ops.deliveryRunMayTarget(
        "promote-and-deploy.yml",
        run,
        "poly",
        "production"
      )
    ).toBe(false);
    expect(
      ops.deliveryRunMayTarget(
        "promote-and-deploy.yml",
        run,
        "red",
        "production"
      )
    ).toBe(true);
    expect(
      ops.deliveryRunMayTarget("promote-and-deploy.yml", run, "red", "preview")
    ).toBe(false);
    expect(
      ops.deliveryRunMayTarget(
        "promote-and-deploy.yml",
        {},
        "red",
        "production"
      )
    ).toBe(true);
    expect(() =>
      ops.assertNoOldRuns([{ id: 1, status: "waiting" }], 2)
    ).toThrow("maintenance_old_delivery_runs_present");
    expect(() =>
      ops.assertNoOldRuns([{ id: 2, status: "in_progress" }], 2)
    ).not.toThrow();
  });

  it("preserves only a positively bound retained server cell, never an app reference", () => {
    const nodeId = "22222222-2222-4222-8222-222222222222";
    const receiptId = "33333333-3333-4333-8333-333333333333";
    const providerAccount = `akash1${"a".repeat(38)}`;
    const binding = {
      version: 1,
      phase: "applied",
      receiptId,
      cogniKey: "persistent-cell",
      nodeId,
      nodeSlug: "poly",
      environment: "production",
      provider: "akash",
      dseq: "123",
      providerAccount,
      endpoint: {
        host: "db.example.com",
        port: 5432,
        tlsMode: "verify-full",
        tlsCertificateSha256: "a".repeat(64),
      },
      databaseName: "cogni_poly",
      appRole: "app_poly",
      serviceRole: "service_poly",
      migrationRole: "migration_poly",
      probeRole: "probe_poly",
      systemIdentifier: "123",
      failureDomainId: `akash:${providerAccount}:123`,
      budgetProfile: "persistent",
      appliedSdlHash: "b".repeat(64),
      cutover: {
        packetSha256: "e".repeat(64),
        actorId: "fixture-owner",
        approvedAt: "2026-10-01T00:00:00Z",
      },
      readyAt: "2026-10-01T00:00:00Z",
      sourceSha: "c".repeat(40),
    };
    const metadata = {
      version: 1,
      retentionPolicy: "retain",
      bindings: [
        {
          allocationEnvironment: "production",
          targetBuildSha: "d".repeat(40),
          initialIncidentId: "native-cell-initial",
          binding,
        },
      ],
    };
    const row = {
      id: receiptId,
      cogni_key: binding.cogniKey,
      node_id: nodeId,
      environment: "production",
      workload: "poly-database-cell",
      external_name: "123",
      provider_account: providerAccount,
      applied_database_cell_binding: metadata,
    };
    const request = {
      nodeId,
      slug: "poly",
      env: "production",
      expected: { receipts: [] },
    };
    expect(
      ops.protectedDatabaseCells(
        [row],
        request,
        DatabaseCellAllocationMetadataSchema
      )
    ).toEqual([
      expect.objectContaining({
        receiptId,
        dseq: "123",
        workload: "poly-database-cell",
        metadataSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(() =>
      ops.protectedDatabaseCells(
        [{ ...row, workload: "poly" }],
        request,
        DatabaseCellAllocationMetadataSchema
      )
    ).toThrow("maintenance_retained_cell_identity_unproven");
    expect(() =>
      ops.protectedDatabaseCells(
        [{ ...row, external_name: "456" }],
        request,
        DatabaseCellAllocationMetadataSchema
      )
    ).toThrow("maintenance_retained_cell_identity_unproven");
    expect(() =>
      ops.protectedDatabaseCells(
        [row],
        { ...request, expected: { receipts: [{ receiptId }] } },
        DatabaseCellAllocationMetadataSchema
      )
    ).toThrow("maintenance_retained_storage_refused");
  });
});
