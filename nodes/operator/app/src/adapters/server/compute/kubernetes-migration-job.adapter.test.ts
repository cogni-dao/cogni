// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { V1Job, V1Pod } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import {
  ComputeLifecycleError,
  type ComputeWorkloadMigrationInput,
} from "@/ports";
import {
  KubernetesMigrationJobAdapter,
  type MigrationJobLogger,
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
    deleteNamespacedJob: vi.fn(async (..._args: unknown[]) => ({ body: {} })),
  };
}

function pods(items: V1Pod[] = []) {
  return {
    listNamespacedPod: vi.fn(async (..._args: unknown[]) => ({
      body: { items },
    })),
  };
}

function warnLog() {
  return {
    warn: vi.fn<(obj: Record<string, unknown>, msg: string) => void>(),
  };
}

/** A pod whose migrate container actually ran and exited with `exitCode`. */
function ranPod(exitCode: number): V1Pod {
  return {
    status: {
      phase: "Failed",
      containerStatuses: [
        {
          name: "migrate-doltgres",
          image: "img",
          imageID: "img",
          ready: false,
          restartCount: 0,
          state: { terminated: { exitCode } },
        },
      ],
    },
  } as V1Pod;
}

/** A pod killed before any migrate container terminated (Pending at deadline). */
function neverRanPod(): V1Pod {
  return {
    status: {
      phase: "Failed",
      containerStatuses: [
        {
          name: "migrate-doltgres",
          image: "img",
          imageID: "img",
          ready: false,
          restartCount: 0,
          state: { waiting: { reason: "ContainerCreating" } },
        },
      ],
    },
  } as V1Pod;
}

function adapterOf(
  api: ReturnType<typeof batch>,
  podApi: ReturnType<typeof pods> = pods(),
  log?: MigrationJobLogger
) {
  return new KubernetesMigrationJobAdapter(
    api as never,
    podApi as never,
    NAMESPACE,
    log
  );
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
    const adapter = adapterOf(api);

    await expect(adapter.ensure(input())).resolves.toBe("running");

    expect(api.createNamespacedJob).toHaveBeenCalledTimes(1);
    const [namespace, job] = api.createNamespacedJob.mock.calls[0] ?? [];
    expect(namespace).toBe(NAMESPACE);
    expect(job?.metadata?.name).toBe(`migrate-toks4-${"a".repeat(12)}`);
    expect(job?.metadata?.labels).toMatchObject({ "cogni.io/node": "toks4" });
    expect(job?.spec).toMatchObject({
      // Bounded in-Job retries: the migrator is idempotent + advisory-locked,
      // so transient DB blips must not terminally poison the digest.
      backoffLimit: 2,
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
    // Requests deliberately tiny (not the k3s 384Mi mirror): a 384Mi request
    // left the Job Pending-then-Failed on a packed single-node env (bug.5116
    // follow-up). Limits still bound actual usage.
    expect(init?.resources).toEqual({
      requests: { memory: "128Mi", cpu: "50m" },
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
    const adapter = adapterOf(api);

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
    const adapter = adapterOf(api);

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
    const adapter = adapterOf(api);

    await expect(adapter.ensure(input())).resolves.toBe("succeeded");
    expect(api.createNamespacedJob).not.toHaveBeenCalled();
  });

  it("keeps a Failed Job whose migrate container exited non-zero terminal and never deletes it", async () => {
    const name = migrationJobName("toks4", DIGEST);
    const api = batch(
      namedJob(name, {
        failed: 1,
        conditions: [{ type: "Failed", status: "True" }],
      })
    );
    const podApi = pods([ranPod(1)]);
    const adapter = adapterOf(api, podApi);

    await expect(adapter.ensure(input())).resolves.toBe("failed");
    expect(api.deleteNamespacedJob).not.toHaveBeenCalled();
    // Pod inspection is scoped to this Job's pods.
    const listArgs = podApi.listNamespacedPod.mock.calls[0] ?? [];
    expect(listArgs[0]).toBe(NAMESPACE);
    expect(listArgs[5]).toBe(`job-name=${name}`);
  });

  it("deletes a Failed Job whose migrate containers never ran and reports running", async () => {
    const name = migrationJobName("toks4", DIGEST);
    const api = batch(
      namedJob(name, {
        failed: 1,
        conditions: [
          { type: "Failed", status: "True", reason: "DeadlineExceeded" },
        ],
      })
    );
    const log = warnLog();
    // Deadline-killed-while-Pending pods are typically gone entirely; an empty
    // pod list is the canonical never-ran shape.
    const adapter = adapterOf(api, pods([]), log);

    await expect(adapter.ensure(input())).resolves.toBe("running");
    expect(api.deleteNamespacedJob).toHaveBeenCalledWith(
      name,
      NAMESPACE,
      undefined,
      undefined,
      undefined,
      undefined,
      "Background"
    );
    expect(api.createNamespacedJob).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        job: name,
        node: "toks4",
        failureReason: "DeadlineExceeded",
      }),
      "compute_workload_migration_job_infra_retry"
    );
  });

  it("retries a Failed Job whose only pod never reached a terminated migrate container", async () => {
    const name = migrationJobName("toks4", DIGEST);
    const api = batch(
      namedJob(name, {
        failed: 1,
        conditions: [{ type: "Failed", status: "True" }],
      })
    );
    const adapter = adapterOf(api, pods([neverRanPod()]), warnLog());

    await expect(adapter.ensure(input())).resolves.toBe("running");
    expect(api.deleteNamespacedJob).toHaveBeenCalledTimes(1);
  });

  it("lets a script failure win over a later infra-failure pod", async () => {
    const name = migrationJobName("toks4", DIGEST);
    const api = batch(
      namedJob(name, {
        failed: 1,
        conditions: [{ type: "Failed", status: "True" }],
      })
    );
    const log = warnLog();
    const adapter = adapterOf(api, pods([neverRanPod(), ranPod(1)]), log);

    await expect(adapter.ensure(input())).resolves.toBe("failed");
    expect(api.deleteNamespacedJob).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("surfaces a pod-inspection failure as transient without deleting the Job", async () => {
    const name = migrationJobName("toks4", DIGEST);
    const api = batch(
      namedJob(name, {
        failed: 1,
        conditions: [{ type: "Failed", status: "True" }],
      })
    );
    const podApi = pods();
    podApi.listNamespacedPod.mockRejectedValue(new Error("api down"));
    const adapter = adapterOf(api, podApi);

    await expect(adapter.ensure(input())).rejects.toMatchObject({
      kind: "transient",
      retryable: true,
    });
    expect(api.deleteNamespacedJob).not.toHaveBeenCalled();
  });

  it("treats a 404 on infra-retry delete as already handled by another pass", async () => {
    const name = migrationJobName("toks4", DIGEST);
    const api = batch(
      namedJob(name, {
        failed: 1,
        conditions: [{ type: "Failed", status: "True" }],
      })
    );
    api.deleteNamespacedJob.mockRejectedValue(notFound());
    const adapter = adapterOf(api, pods([]), warnLog());

    await expect(adapter.ensure(input())).resolves.toBe("running");
  });

  it("garbage-collects only FINISHED superseded digests once the current digest succeeds", async () => {
    const keep = migrationJobName("toks4", DIGEST);
    const staleComplete = `migrate-toks4-${"9".repeat(12)}`;
    const staleFailed = `migrate-toks4-${"8".repeat(12)}`;
    const staleRunning = `migrate-toks4-${"7".repeat(12)}`;
    const complete = {
      succeeded: 1,
      conditions: [{ type: "Complete", status: "True" }],
    };
    const api = batch(namedJob(keep, complete), [
      namedJob(keep, complete),
      namedJob(staleComplete, complete),
      namedJob(staleFailed, {
        failed: 1,
        conditions: [{ type: "Failed", status: "True" }],
      }),
      // A rollback race must never kill another digest's migration mid-flight.
      namedJob(staleRunning, { active: 1 }),
      namedJob("migrate-other-node-abcdefabcdef", complete),
    ]);
    const adapter = adapterOf(api);

    await expect(adapter.ensure(input())).resolves.toBe("succeeded");
    const deleted = api.deleteNamespacedJob.mock.calls.map((call) => call[0]);
    expect(deleted.sort()).toEqual([staleFailed, staleComplete].sort());
    expect(api.deleteNamespacedJob).toHaveBeenCalledWith(
      staleComplete,
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
    const adapter = adapterOf(api);

    await expect(adapter.ensure(input())).resolves.toBe("succeeded");
  });

  it("treats a create conflict as running (another pass won the race)", async () => {
    const api = batch();
    api.createNamespacedJob.mockRejectedValue(
      Object.assign(new Error("conflict"), { statusCode: 409 })
    );
    const adapter = adapterOf(api);

    await expect(adapter.ensure(input())).resolves.toBe("running");
  });

  it("surfaces read/create API failures as transient lifecycle errors", async () => {
    const readFail = batch();
    readFail.readNamespacedJob.mockRejectedValue(
      Object.assign(new Error("api down"), { statusCode: 500 })
    );
    await expect(adapterOf(readFail).ensure(input())).rejects.toMatchObject({
      kind: "transient",
      retryable: true,
    });

    const createFail = batch();
    createFail.createNamespacedJob.mockRejectedValue(
      Object.assign(new Error("forbidden"), { statusCode: 403 })
    );
    await expect(adapterOf(createFail).ensure(input())).rejects.toMatchObject({
      kind: "transient",
      retryable: true,
    });
  });
});
