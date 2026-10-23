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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolveDeploymentTargets } from "@/features/compute/node-deployment-targets";
import { DatabaseCellAllocationMetadataSchema } from "@/shared/secrets/database-cell-placement.data";

const root = path.resolve(__dirname, "../..");
const modulePath = pathToFileURL(
  path.join(root, "scripts/ops/maintenance-drain.mjs")
).href;
const ops = await import(modulePath);

describe("maintenance drain proof boundary", () => {
  it("denies present malformed/active fences and unmerged floors; stale writers cannot push", () => {
    const program = `
import importlib.util,json,pathlib,subprocess,sys,tempfile
spec=importlib.util.spec_from_file_location("fence",sys.argv[1]);f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d);state=root/".promote-state";state.mkdir()
 f.check(root)
 for value in ("null", "[]", "{", '{}', '{"phase":"audited","allowRollback":true}'):
  (state/"maintenance-drain.json").write_text(value)
  try:f.check(root);raise AssertionError("present marker allowed")
  except RuntimeError:pass
 (state/"maintenance-drain.json").unlink()
 receipt={"version":1,"phase":"audited","operationId":"a"*64,"request":{"sourceRepository":"owned/repo","sourceSha":"b"*40}}
 (state/"maintenance-drain-receipt.json").write_text(json.dumps(receipt))
 for statuses in (("diverged","ahead"),("ahead","behind"),("ahead","diverged"),("ahead","unknown")):
  values=iter(statuses)
  try:f.check(root,"owned/repo","c"*40,lambda *args:next(values));raise AssertionError("invalid floor allowed")
  except RuntimeError:pass
 f.check(root,"owned/repo","c"*40,lambda *args:"ahead")
 def git(*args,cwd=None):return subprocess.run(["git",*args],cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True)
 bare=root/"remote.git";git("init","--bare",str(bare))
 a=root/"a";b=root/"b";git("clone",str(bare),str(a))
 for directory in (a,):
  git("config","user.email","owned@example.test",cwd=directory);git("config","user.name","Owned fixture",cwd=directory)
 (a/"seed").write_text("seed");git("add",".",cwd=a);git("commit","-m","seed",cwd=a);git("push","origin","HEAD:main",cwd=a)
 git("clone","--branch","main",str(bare),str(b))
 git("config","user.email","owned@example.test",cwd=b);git("config","user.name","Owned fixture",cwd=b)
 (a/".promote-state").mkdir();(a/".promote-state/maintenance-drain.json").write_text('{"phase":"fenced"}')
 git("add",".",cwd=a);git("commit","-m","fence",cwd=a);git("push","origin","HEAD:main",cwd=a)
 (b/"old-workload").write_text("old");git("add",".",cwd=b);git("commit","-m","stale writer",cwd=b)
 result=subprocess.run(["git","push","origin","HEAD:main"],cwd=b,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 assert result.returncode != 0
`;
    execFileSync(
      "python3",
      ["-c", program, path.join(root, "scripts/ci/lib/maintenance-fence.py")],
      { stdio: "pipe", timeout: 10000 }
    );
  });

  // bug.5510: the candidate-a operator receipt names `cogni-dao/cogni`, but the
  // in-repo self-flight handed the fence SOURCE_REPOSITORY="" and every operator
  // flight failed `maintenance_compatibility_floor_invalid`. The producer now
  // emits the parent repository; the fence itself stays strict.
  it("compares an in-repo target's floor using the producer's parent repository (bug.5510)", () => {
    const selection = resolveDeploymentTargets({
      catalogRows: [{ name: "operator", type: "node", envs: ["candidate-a"] }],
      environment: "candidate-a",
      parentRepository: "cogni-dao/cogni",
      flightTargets: ["operator"],
    });
    const repository = selection.sourceRepositories.operator;
    expect(repository).toBe("cogni-dao/cogni");

    const program = `
import importlib.util,json,pathlib,sys,tempfile
spec=importlib.util.spec_from_file_location("fence",sys.argv[1]);f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
repository=sys.argv[2];floor="3e8ebeab9ce76be7bf5429ba23cee01062c2c7a2";head="c"*40
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d);state=root/".promote-state";state.mkdir()
 receipt={"version":1,"phase":"audited","operationId":"a"*64,"request":{"slug":"operator","env":"candidate-a","sourceSha":floor,"sourceRepository":"cogni-dao/cogni"}}
 (state/"maintenance-drain-receipt.json").write_text(json.dumps(receipt))
 calls=[]
 def compare(*args):
  calls.append(args);return "ahead"
 # The incident shape: an empty or foreign repository never reaches the floor comparison.
 for wrong in (None,"","cogni-test-org/cogni-monorepo"):
  try:f.check(root,wrong,head,compare);raise AssertionError("repository mismatch allowed")
  except RuntimeError as e:assert str(e)=="maintenance_compatibility_floor_invalid",e
 assert calls==[]
 f.check(root,repository,head,compare)
 assert calls==[(repository,floor,"main"),(repository,floor,head)],calls
 # The floor is still enforced for the in-repo identity.
 try:f.check(root,repository,head,lambda *a:"ahead" if a[2]=="main" else "behind");raise AssertionError("floor violation allowed")
 except RuntimeError as e:assert str(e)=="maintenance_compatibility_floor_violation",e
`;
    execFileSync(
      "python3",
      [
        "-c",
        program,
        path.join(root, "scripts/ci/lib/maintenance-fence.py"),
        repository ?? "",
      ],
      { stdio: "pipe", timeout: 10000 }
    );
  });

  it("compiles the actual read-only runner snapshot programs", () => {
    const command = ops.candidateSnapshotCommand({
      env: "candidate-a",
      slug: "node-template",
      nodeId: "owned-node",
    });
    const scripts = [...command.matchAll(/<<'(PY_[A-Z]+)'\n([\s\S]*?)\n\1/g)];
    expect(scripts).toHaveLength(3);
    for (const [, , source] of scripts) {
      execFileSync(
        "python3",
        ["-c", "import ast,sys; ast.parse(sys.stdin.read())"],
        { input: source, timeout: 5000 }
      );
    }
    execFileSync("bash", ["-n"], { input: command, timeout: 5000 });
  });

  it("executes the actual snapshot with owned engine identity and private native failures", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "maintenance-snapshot-"));
    const images = {
      postgres: "postgres:15",
      doltgres: "dolthub/doltgresql:0.57.3",
    };
    const command = ops.candidateSnapshotCommand({
      env: "candidate-a",
      nodeId: "owned-node",
      slug: "node-template",
      expectedEngineImages: images,
    });
    const docker = `#!/usr/bin/env python3
import json,os,sys
service="postgres" if any("service=postgres" in a for a in sys.argv) or sys.argv[-1].startswith("a") else "doltgres"
key="a" if service=="postgres" else "b"
if sys.argv[1]=="ps":
 print(key*64)
 if os.environ.get("MOCK_AMBIGUOUS")==service: print("c"*64)
else:
 print(json.dumps({"id":key*64,"image":"wrong/image:1" if os.environ.get("MOCK_WRONG_IMAGE")==service else {"postgres":"postgres:15","doltgres":"dolthub/doltgresql:0.57.3"}[service],"imageId":"sha256:"+key*64,"startedAt":"2026-10-20T20:00:00Z","restartCount":0,"running":True,"project":"cogni-runtime","service":service,"workingDir":"/opt/cogni-template-runtime"}))
`;
    const kubectl = `#!/usr/bin/env python3
import json,os,sys
if "api-resources" in sys.argv:
 print("computeworkloads.compute.cogni.io"); print("xcomputeworkloads.compute.cogni.io")
elif "applications.argoproj.io" in sys.argv and os.environ.get("MOCK_FAIL_APPS"):
 print("PRIVATE_STDERR_SENTINEL",file=sys.stderr);sys.exit(17)
else:
 items=[]
 if "xcomputeworkloads.compute.cogni.io" in sys.argv:
  items=[{"kind":"XComputeWorkload","metadata":{"name":"owned-node","uid":"xr-id","generation":3,"labels":{"cogni.io/node-id":"owned-node"}},"spec":{"nodeId":"owned-node","bundle":{"source":{"sha":"old-source"}},"workload":{"name":"node-template"}},"status":{"observedGeneration":3}}]
 elif "applicationsets.argoproj.io" in sys.argv:
  items=[{"metadata":{"name":"node-apps","uid":"set-id"},"spec":{"template":{"spec":{"source":{"repoURL":"https://github.com/owned/repo","targetRevision":"main","helm":{"values":"PRIVATE_INLINE_SECRET"}}}},"generators":[{"git":{}}]}}]
 print(json.dumps({"items":items}))
`;
    writeFileSync(path.join(dir, "timeout"), '#!/bin/sh\nshift\nexec "$@"\n', {
      mode: 0o755,
    });
    writeFileSync(path.join(dir, "docker"), docker, { mode: 0o755 });
    writeFileSync(path.join(dir, "kubectl"), kubectl, { mode: 0o755 });
    const execute = (extra: Record<string, string> = {}) =>
      execFileSync("bash", ["-s"], {
        input: command,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 5000,
        env: {
          ...process.env,
          PATH: dir + path.delimiter + process.env.PATH,
          ...extra,
        },
      });
    try {
      writeFileSync(
        path.join(dir, "ssh"),
        "#!/bin/sh\necho PRIVATE_SSH_STDERR_SENTINEL >&2\nexit 17\n",
        { mode: 0o755 }
      );
      let cliFailure: unknown;
      try {
        execFileSync(
          process.execPath,
          [
            path.join(root, "scripts/ops/maintenance-drain.mjs"),
            "candidate-preflight",
          ],
          {
            encoding: "utf8",
            stdio: "pipe",
            timeout: 5000,
            env: {
              ...process.env,
              PATH: dir + path.delimiter + process.env.PATH,
              GITHUB_REPOSITORY: "cogni-dao/cogni",
              NODE: "node-template",
              CONTROL_ENV: "production",
              APP_SOURCE_ROOT: root,
              CI_SOURCE_ROOT: root,
            },
          }
        );
      } catch (error) {
        cliFailure = error;
      }
      expect(cliFailure).toBeDefined();
      const cliStderr = String((cliFailure as { stderr: string }).stderr);
      expect(cliStderr).toContain('"phase":"ledger_inventory","native_rc":17');
      expect(cliStderr).not.toContain("PRIVATE_SSH_STDERR_SENTINEL");
      const leakLog = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(() =>
          ops.parseCandidateSnapshotOutput(
            'MAINTENANCE_ENGINE_IDENTITY {"engines":[{"secret":"PRIVATE_RECEIPT_SENTINEL"},{}]}\n{}',
            images
          )
        ).toThrow(/engine_receipt_unproven/);
        expect(leakLog).not.toHaveBeenCalled();
      } finally {
        leakLog.mockRestore();
      }
      const output = execute();
      expect(output).toContain("MAINTENANCE_ENGINE_IDENTITY");
      expect(output).not.toContain("PRIVATE_INLINE_SECRET");
      const lines = output.trim().split("\n");
      expect(
        JSON.parse(
          (lines[0] ?? "").slice("MAINTENANCE_ENGINE_IDENTITY ".length)
        ).engines
      ).toHaveLength(2);
      const receiptLog = vi.spyOn(console, "log").mockImplementation(() => {});
      let parsedSnapshot: unknown;
      try {
        parsedSnapshot = ops.parseCandidateSnapshotOutput(output, images);
        expect(receiptLog).toHaveBeenCalledOnce();
      } finally {
        receiptLog.mockRestore();
      }
      const snapshot = JSON.parse(lines[1] ?? "");
      expect(parsedSnapshot).toEqual(snapshot);
      expect(snapshot.xrs[0]).toMatchObject({
        kind: "XComputeWorkload",
        uid: "xr-id",
        bundleSource: "old-source",
      });
      expect(snapshot.applicationSets[0].templateSource).toEqual({
        repoURL: "https://github.com/owned/repo",
        targetRevision: "main",
      });
      const failures: Record<string, string>[] = [
        { MOCK_FAIL_APPS: "1" },
        { MOCK_AMBIGUOUS: "postgres" },
        { MOCK_WRONG_IMAGE: "doltgres" },
      ];
      for (const extra of failures) {
        let caught: unknown;
        try {
          execute(extra);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeDefined();
        const failure = caught as {
          status: number;
          stdout: string;
          stderr: string;
        };
        expect(failure.stderr).not.toContain("PRIVATE_STDERR_SENTINEL");
        expect(failure.stderr).not.toContain("Traceback");
        expect(failure.stderr).toContain(
          extra.MOCK_FAIL_APPS
            ? "phase=applications native_rc=17"
            : "phase=engine_inventory native_rc=1"
        );
        if (extra.MOCK_FAIL_APPS)
          expect(failure.stdout).toContain("MAINTENANCE_ENGINE_IDENTITY");
        else
          expect(failure.stdout).not.toContain("MAINTENANCE_ENGINE_IDENTITY");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
