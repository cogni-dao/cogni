// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/native/cadvisor-actor-coverage`
 * Purpose: Measure native container attribution before changing collector configuration.
 * Scope: Exact declared Alloy image, cAdvisor block and collector-relevant host mounts in isolated CI.
 * Invariants:
 *   - RAW_ACTOR_COVERAGE: both owned actors appear before downstream relabeling.
 *   - REAL_IO: a finite fsync workload increases its own exported write counter.
 *   - ROOT_IS_NOT_AN_ACTOR: root-only metrics cannot satisfy container coverage.
 *   - BASELINE_ONLY: this test adds no collector mounts, capabilities or runtime policy.
 * Side-effects: IO (CI-owned Docker containers; reads declared host mounts and writes an owned 16MiB file).
 * Links: story.5095, task.5280, docs/spec/cicd-platform-boundary.md
 * @internal
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Docker from "dockerode";
import {
  GenericContainer,
  Network,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const runtime = path.resolve(__dirname, "../../../infra/compose/runtime");
interface Service {
  image: string;
  user?: string;
  volumes?: string[];
  privileged?: boolean;
  cap_add?: string[];
  cap_drop?: string[];
  security_opt?: string[];
  cgroup?: string;
  pid?: string;
}
const { services } = yaml.parse(
  readFileSync(path.join(runtime, "docker-compose.yml"), "utf8")
) as { services: Record<string, Service> };

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

function samples(text: string): Sample[] {
  return text.split("\n").flatMap((line) => {
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    if (!match) return [];
    const value = Number(match[3]);
    if (!Number.isFinite(value)) return [];
    const labels: Record<string, string> = {};
    for (const label of (match[2] ?? "").matchAll(
      /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g
    )) {
      labels[label[1]] = JSON.parse(`"${label[2]}"`) as string;
    }
    return [{ name: match[1], labels, value }];
  });
}

function actorRows(rows: Sample[], actor: StartedTestContainer): Sample[] {
  return rows.filter((row) => row.labels.id?.includes(actor.getId()));
}

function writeBytes(rows: Sample[]): number | undefined {
  const writes = rows.filter(
    (row) => row.name === "container_fs_writes_bytes_total"
  );
  return writes.length
    ? writes.reduce((sum, row) => sum + row.value, 0)
    : undefined;
}

function coverage(
  rows: Sample[],
  actor: StartedTestContainer,
  service: string
) {
  const owned = actorRows(rows, actor);
  return [
    "container_cpu_usage_seconds_total",
    "container_memory_working_set_bytes",
  ].every((metric) =>
    owned.some(
      (row) =>
        row.name === metric &&
        row.labels.container_label_com_docker_compose_service === service
    )
  );
}

async function poll<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value: T;
  do {
    value = await read();
    if (accept(value)) return value;
    await delay(2_000);
  } while (Date.now() < deadline);
  return value;
}

if (!process.env.CI) {
  console.warn(
    "cAdvisor native attribution measurement is CI-only and SKIPPED locally; no actor coverage is proven."
  );
}

describe.skipIf(!process.env.CI)(
  "Declared cAdvisor native actor coverage",
  () => {
    it("exports two owned actors and attributes a finite fsync write before relabeling", async () => {
      const docker = new Docker({ timeout: 10_000 });
      await docker.ping();
      const network = await new Network().start();
      const owned: StartedTestContainer[] = [];
      const cleanup: PromiseSettledResult<unknown>[] = [];
      const collectorErrorClasses = new Set<string>();
      const token = randomUUID();
      const writerService = `io-writer-${token}`;
      const idleService = `io-idle-${token}`;
      try {
        const alloyService = services.alloy;
        // Do not silently omit a new isolation/security setting when declarations change.
        for (const key of [
          "privileged",
          "cap_add",
          "cap_drop",
          "security_opt",
          "cgroup",
          "pid",
        ] as const) {
          expect(
            alloyService[key],
            `Unmodelled Compose Alloy setting: ${key}`
          ).toBeUndefined();
        }
        const mounts = (alloyService.volumes ?? []).flatMap((volume) => {
          const [source, target, mode] = volume.split(":");
          // Log mounts belong to components omitted from this focused exporter fixture.
          // All existing collector-visible host roots/socket retain their exact targets.
          if (!source.startsWith("/") || source.startsWith("/var/log/"))
            return [];
          expect(mode, `Host mount must remain read-only: ${target}`).toBe(
            "ro"
          );
          return [{ source, target, mode: "ro" as const }];
        });
        expect(
          mounts.some((mount) => mount.target === "/var/run/docker.sock")
        ).toBe(true);
        const config = readFileSync(
          path.join(runtime, "configs/alloy-config.metrics.alloy"),
          "utf8"
        );
        // The current exporter block is flat. Fail on nested/different syntax rather than
        // substituting a fixture policy or reading environment-specific remote-write secrets.
        const exporter = config.match(
          /^prometheus\.exporter\.cadvisor "default" \{\n[^{}]*^\}/m
        )?.[0];
        expect(
          exporter,
          "Could not extract exact committed cAdvisor component"
        ).toBeTruthy();
        const host = await docker.info();
        console.info(
          "CADVISOR_DECLARED_BASELINE",
          JSON.stringify({
            image: alloyService.image,
            exporterSha256: createHash("sha256")
              .update(exporter ?? "")
              .digest("hex"),
            mounts,
            user: alloyService.user,
            cgroupDriver: host.CgroupDriver,
            cgroupVersion: host.CgroupVersion,
            scope: "CI host only; production cgroup topology is not inferred",
          })
        );
        const actor = async (service: string) => {
          const container = await new GenericContainer(
            services["git-sync-init"].image
          )
            .withNetwork(network)
            .withLabels({
              "com.docker.compose.service": service,
              "cogni.native-proof": token,
            })
            .withEntrypoint(["/bin/sh", "-c"])
            .withCommand(["sleep 240"])
            .withWaitStrategy(Wait.forSuccessfulCommand("test -d /tmp"))
            .start();
          owned.push(container);
          return container;
        };
        const writer = await actor(writerService);
        const idle = await actor(idleService);
        const alloy = await new GenericContainer(alloyService.image)
          .withNetwork(network)
          .withUser(alloyService.user ?? "")
          .withBindMounts(mounts)
          .withTmpFs({ "/var/lib/alloy": "rw" })
          .withCopyContentToContainer([
            { content: `${exporter}\n`, target: "/etc/alloy/config.alloy" },
          ])
          .withCommand([
            "run",
            "/etc/alloy/config.alloy",
            "--server.http.listen-addr=0.0.0.0:12345",
            "--storage.path=/var/lib/alloy",
          ])
          .withExposedPorts(12345)
          .withLogConsumer((stream) => {
            // Bound diagnostics and avoid exporting unrelated host-container inventory.
            stream.on("data", (chunk: Buffer) => {
              const text = chunk.toString("utf8");
              for (const signature of [
                "permission denied",
                "no such file or directory",
                "cgroup mountpoint",
                "Failed to create",
                "Failed to register",
                "Failed to get",
              ])
                if (text.includes(signature))
                  collectorErrorClasses.add(signature);
            });
          })
          .withWaitStrategy(Wait.forHttp("/-/ready", 12345))
          .withStartupTimeout(90_000)
          .start();
        owned.push(alloy);
        const base = `http://${alloy.getHost()}:${alloy.getMappedPort(12345)}`;
        const raw = async () => {
          const response = await fetch(
            `${base}/api/v0/component/prometheus.exporter.cadvisor.default/metrics`,
            {
              signal: AbortSignal.timeout(10_000),
            }
          );
          expect(response.status).toBe(200);
          return samples(await response.text());
        };
        const before = await poll(
          raw,
          (rows) =>
            coverage(rows, writer, writerService) &&
            coverage(rows, idle, idleService) &&
            writeBytes(actorRows(rows, writer)) !== undefined,
          65_000
        );
        const evidence = (rows: Sample[]) => ({
          // Export only our actors, not unrelated CI-host container inventory.
          owned: [writer, idle].map((container) => ({
            id: container.getId(),
            rows: actorRows(rows, container).filter((row) =>
              /^(container_(cpu_usage_seconds_total|memory_working_set_bytes|fs_(reads|writes)_bytes_total|blkio_device_usage_total))$/.test(
                row.name
              )
            ),
          })),
          rootMetrics: [
            ...new Set(
              rows.filter((row) => row.labels.id === "/").map((row) => row.name)
            ),
          ],
        });
        console.info("CADVISOR_BASELINE_RAW", JSON.stringify(evidence(before)));
        console.info("CADVISOR_COLLECTOR_ERROR_CLASSES", [
          ...collectorErrorClasses,
        ]);
        const actualRootOnly =
          before.some((row) => row.labels.id === "/") &&
          actorRows(before, writer).length === 0 &&
          actorRows(before, idle).length === 0;
        console.info("CADVISOR_ACTUAL_ROOT_ONLY_OBSERVATION", actualRootOnly);
        // Explicit sensitivity control: visible root series are never counted as actors.
        const rootOnly = before.filter((row) => row.labels.id === "/");
        expect(coverage(rootOnly, writer, writerService)).toBe(false);
        expect(coverage(rootOnly, idle, idleService)).toBe(false);
        expect(
          coverage(before, writer, writerService),
          "Missing raw owned writer identity; inspect collector scope before relabeling"
        ).toBe(true);
        expect(
          coverage(before, idle, idleService),
          "Missing raw owned idle identity; this is not two-actor coverage"
        ).toBe(true);
        const baseline = writeBytes(actorRows(before, writer));
        expect(
          baseline,
          "No owned write counter; CPU/memory coverage alone is insufficient"
        ).toBeDefined();
        const write = await writer.exec([
          "/bin/sh",
          "-c",
          "dd if=/dev/zero of=/tmp/cadvisor-proof bs=1M count=16 conv=fsync",
        ]);
        expect(write.exitCode, write.output).toBe(0);
        const after = await poll(
          raw,
          (rows) =>
            (writeBytes(actorRows(rows, writer)) ?? -1) > (baseline ?? 0),
          65_000
        );
        console.info(
          "CADVISOR_AFTER_FSYNC_RAW",
          JSON.stringify(evidence(after))
        );
        expect(
          writeBytes(actorRows(after, writer)),
          "Finite fsync write had no actor-attributed exporter delta"
        ).toBeGreaterThan(baseline ?? 0);
      } finally {
        // No faults or writes target another container; attempt all owned cleanup.
        for (const container of owned.reverse()) {
          cleanup.push(...(await Promise.allSettled([container.stop()])));
        }
        cleanup.push(...(await Promise.allSettled([network.stop()])));
      }
      const failed = cleanup.filter((result) => result.status === "rejected");
      expect(failed, "Owned native fixture cleanup failed").toEqual([]);
    }, 240_000);
  }
);
