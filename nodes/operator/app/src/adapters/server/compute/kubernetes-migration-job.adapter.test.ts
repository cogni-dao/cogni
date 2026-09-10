// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { V1Job } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import {
  ComputeLifecycleError,
  type ComputeWorkloadMigrationInput,
} from "@/ports";
import {
  KubernetesMigrationJobAdapter,
  migrationJobName,
} from "./kubernetes-migration-job.adapter";

const DIGEST = `sha256:${"a".repeat(64)}`;
const NAMESPACE = "cogni-production";

const POSTGRES_PHASE = {
  name: "migrate",
  command: [
    "/bin/sh",
    "-c",
    "exec node /app/app/migrate.mjs /app/app/migrations",
  ],
  databaseUrlSecretKey: "DATABASE_URL",
} as const;
const DOLTGRES_PHASE = {
  name: "migrate-doltgres",
  command: [
    "/bin/sh",
    "-c",
    "exec node /app/app/migrate-doltgres.mjs /app/app/doltgres-migrations",
  ],
  databaseUrlSecretKey: "DOLTGRES_URL",
} as const;

function input(
  overrides: Partial<ComputeWorkloadMigrationInput> = {}
): ComputeWorkloadMigrationInput {
  return {
    nodeSlug: "toks4",
    environment: "production",
    bundleDigest: DIGEST,
    image: `ghcr.io/cogni-dao/toks4@sha256:${"b".repeat(64)}`,
    secretName: "toks4-compute-env-secrets",
    phases: [POSTGRES_PHASE, DOLTGRES_PHASE],
    ...overrides,
  };
}

function notFound(): Error {
  return Object.assign(new Error("not found"), { statusCode: 404 });
}

function batch(job?: V1Job, jobs: V1Job[] = []) {
  return {
    readNamespacedJob: vi.fn(async () => {
      if (!job) throw notFound();
      return { body: job };
    }),
    createNamespacedJob: vi.fn(async (_ns: string, body: V1Job) => ({
      body,
    })),
    listNamespacedJob: vi.fn(async () => ({ body: { items: jobs } })),
    deleteNamespacedJob: vi.fn(async () => ({ body: {} })),
  };
}

function namedJob(name: string, status: V1Job["status"] = {}): V1Job {
  return {
    metadata: {
      name,
      labels: {
        "cogni.io/node": "toks4",
        "app.kubernetes.io/managed-by": "compute-workload-controller",
      },
    },
    status,
  };
}

describe("migrationJobName", () => {
  it("pins the job name to the first 12 digest hex chars per node", () => {
    expect(migrationJobName("toks4", DIGEST)).toBe(
      `migrate-toks4-${"a".repeat(12)}`
    );
  });

  it("rejects a malformed digest terminally", () => {
    expect(() => migrationJobName("toks4", "latest")).toThrow(
      ComputeLifecycleError
    );
  });
});

describe("KubernetesMigrationJobAdapter", () => {
  it("creates the per-digest Job with mirrored spec and reports running", async () => {
    const api = batch();
    const adapter = new KubernetesMigrationJobAdapter(api as never, NAMESPACE);

    await expect(adapter.ensure(input())).resolves.toBe("running");

    expect(api.createNamespacedJob).toHaveBeenCalledTimes(1);
    const [namespace, job] = api.createNamespacedJob.mock.calls[0] ?? [];
    expect(namespace).toBe(NAMESPACE);
    expect(job?.metadata?.name).toBe(`migrate-toks4-${"a".repeat(12)}`);
    expect(job?.metadata?.labels).toMatchObject({ "cogni.io/node": "toks4" });
    expect(job?.spec).toMatchObject({
      backoffLimit: 0,
      activeDeadlineSeconds: 600,
    });
    // Deliberately no TTL: the completed Job IS the durable skip marker.
    expect(job?.spec?.ttlSecondsAfterFinished).toBeUndefined();

    const pod = job?.spec?.template.spec;
    expect(pod?.restartPolicy).toBe("Never");
    const init = pod?.initContainers?.[0];
    const main = pod?.containers[0];
    expect(init?.name).toBe("migrate");
    expect(init?.image).toBe(input().image);
    expect(init?.command).toEqual([...POSTGRES_PHASE.command]);
    expect(init?.env).toEqual([
      { name: "NODE_NAME", value: "toks4" },
      {
        name: "DATABASE_URL",
        valueFrom: {
          secretKeyRef: {
            name: "toks4-compute-env-secrets",
            key: "DATABASE_URL",
          },
        },
      },
    ]);
    expect(init?.resources).toEqual({
      requests: { memory: "384Mi", cpu: "200m" },
      limits: { memory: "1Gi", cpu: "1000m" },
    });
    expect(main?.name).toBe("migrate-doltgres");
    expect(main?.command).toEqual([...DOLTGRES_PHASE.command]);
    expect(main?.env).toContainEqual({
      name: "DATABASE_URL",
      valueFrom: {
        secretKeyRef: {
          name: "toks4-compute-env-secrets",
          key: "DOLTGRES_URL",
        },
      },
    });
  });

  it("renders a single postgres phase as the main container with no initContainers", async () => {
    const api = batch();
    const adapter = new KubernetesMigrationJobAdapter(api as never, NAMESPACE);

    await adapter.ensure(input({ phases: [POSTGRES_PHASE] }));

    const pod = api.createNamespacedJob.mock.calls[0]?.[1]?.spec?.template.spec;
    expect(pod?.initContainers).toBeUndefined();
    expect(pod?.containers).toHaveLength(1);
    expect(pod?.containers[0]?.name).toBe("migrate");
    expect(pod?.containers[0]?.env).toContainEqual({
      name: "DATABASE_URL",
      valueFrom: {
        secretKeyRef: {
          name: "toks4-compute-env-secrets",
          key: "DATABASE_URL",
        },
      },
    });
  });

  it("classifies an active Job as running without creating another", async () => {
    const name = migrationJobName("toks4", DIGEST);
    const api = batch(namedJob(name, { active: 1 }));
    const adapter = new KubernetesMigrationJobAdapter(api as never, NAMESPACE);

    await expect(adapter.ensure(input())).resolves.toBe("running");
    expect(api.createNamespacedJob).not.toHaveBeenCalled();
  });

  it("classifies a completed Job as succeeded", async () => {
    const name = migrationJobName("toks4", DIGEST);
    const api = batch(
      namedJob(name, {
        succeeded: 1,
        conditions: [{ type: "Complete", status: "True" }],
      })
    );
    const adapter = new KubernetesMigrationJobAdapter(api as never, NAMESPACE);

    await expect(adapter.ensure(input())).resolves.toBe("succeeded");
    expect(api.createNamespacedJob).not.toHaveBeenCalled();
  });

  it("classifies a Failed-conditioned Job as failed and never deletes it", async () => {
    const name = migrationJobName("toks4", DIGEST);
    const api = batch(
      namedJob(name, {
        failed: 1,
        conditions: [{ type: "Failed", status: "True" }],
      })
    );
    const adapter = new KubernetesMigrationJobAdapter(api as never, NAMESPACE);

    await expect(adapter.ensure(input())).resolves.toBe("failed");
    expect(api.deleteNamespacedJob).not.toHaveBeenCalled();
  });

  it("garbage-collects superseded digests once the current digest succeeds", async () => {
    const keep = migrationJobName("toks4", DIGEST);
    const stale = `migrate-toks4-${"9".repeat(12)}`;
    const api = batch(namedJob(keep, { succeeded: 1 }), [
      namedJob(keep, { succeeded: 1 }),
      namedJob(stale, { succeeded: 1 }),
      namedJob("migrate-other-node-abcdefabcdef"),
    ]);
    const adapter = new KubernetesMigrationJobAdapter(api as never, NAMESPACE);

    await expect(adapter.ensure(input())).resolves.toBe("succeeded");
    expect(api.deleteNamespacedJob).toHaveBeenCalledTimes(1);
    expect(api.deleteNamespacedJob).toHaveBeenCalledWith(
      stale,
      NAMESPACE,
      undefined,
      undefined,
      undefined,
      undefined,
      "Background"
    );
  });

  it("still reports succeeded when superseded-job GC fails", async () => {
    const keep = migrationJobName("toks4", DIGEST);
    const api = batch(namedJob(keep, { succeeded: 1 }));
    api.listNamespacedJob.mockRejectedValue(new Error("boom"));
    const adapter = new KubernetesMigrationJobAdapter(api as never, NAMESPACE);

    await expect(adapter.ensure(input())).resolves.toBe("succeeded");
  });

  it("treats a create conflict as running (another pass won the race)", async () => {
    const api = batch();
    api.createNamespacedJob.mockRejectedValue(
      Object.assign(new Error("conflict"), { statusCode: 409 })
    );
    const adapter = new KubernetesMigrationJobAdapter(api as never, NAMESPACE);

    await expect(adapter.ensure(input())).resolves.toBe("running");
  });

  it("surfaces read/create API failures as transient lifecycle errors", async () => {
    const readFail = batch();
    readFail.readNamespacedJob.mockRejectedValue(
      Object.assign(new Error("api down"), { statusCode: 500 })
    );
    await expect(
      new KubernetesMigrationJobAdapter(readFail as never, NAMESPACE).ensure(
        input()
      )
    ).rejects.toMatchObject({ kind: "transient", retryable: true });

    const createFail = batch();
    createFail.createNamespacedJob.mockRejectedValue(
      Object.assign(new Error("forbidden"), { statusCode: 403 })
    );
    await expect(
      new KubernetesMigrationJobAdapter(createFail as never, NAMESPACE).ensure(
        input()
      )
    ).rejects.toMatchObject({ kind: "transient", retryable: true });
  });
});
