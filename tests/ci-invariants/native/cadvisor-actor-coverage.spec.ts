// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/native/cadvisor-actor-coverage`
 * Purpose: Prove declared collector attribution with a genuine historical negative control.
 * Scope: CI-owned Docker only. Does not access deployed environments or credentials.
 * Invariants:
 *   - RAW_ACTOR_COVERAGE: both owned actors appear before downstream relabeling.
 *   - REAL_IO: a finite fsync workload increases its own exported write counter.
 *   - ROOT_IS_NOT_AN_ACTOR: root-only metrics cannot satisfy container coverage.
 *   - DECLARED_VISIBILITY: positive actor scope comes from the actual Compose declaration.
 *   - BASELINE_CONTROL: historical private namespace without metadata exposes root only.
 * Side-effects: IO (CI-owned Docker containers; reads declared host mounts and writes an owned 16MiB file).
 * Links: story.5095, task.5280, docs/spec/cicd-platform-boundary.md
 * @internal
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
  volumes?: (
    | string
    | {
        type: string;
        source: string;
        target: string;
        read_only?: boolean;
        bind?: { create_host_path?: boolean };
      }
  )[];
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

// Docker Engine supports CgroupnsMode; the installed dockerode declarations predate it.
class HostCgroupContainer extends GenericContainer {
  constructor(image: string, metadataPath: string) {
    super(image);
    Object.assign(this.hostConfig, { CgroupnsMode: "host" });
    // Docker's long-mount ABI rejects absent sources, matching create_host_path:false.
    this.hostConfig.Mounts = [
      {
        Type: "bind",
        Source: metadataPath,
        Target: metadataPath,
        ReadOnly: true,
      },
    ];
  }
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
      const collectorErrors = new Set<string>();
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
          "pid",
        ] as const) {
          expect(
            alloyService[key],
            `Unmodelled Compose Alloy setting: ${key}`
          ).toBeUndefined();
        }
        expect(alloyService.cgroup).toBe("host");
        const metadataPath = "/var/lib/docker/image/overlay2/layerdb/mounts";
        const metadata = (alloyService.volumes ?? []).find(
          (volume) =>
            typeof volume !== "string" && volume.target === metadataPath
        );
        expect(metadata).toMatchObject({
          type: "bind",
          source: metadataPath,
          target: metadataPath,
          read_only: true,
          bind: { create_host_path: false },
        });
        const mounts = (alloyService.volumes ?? []).flatMap((volume) => {
          const [source, target, mode] =
            typeof volume === "string"
              ? volume.split(":")
              : [volume.source, volume.target, volume.read_only ? "ro" : "rw"];
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
        const deploySource = readFileSync(
          path.resolve(runtime, "../../../scripts/ci/deploy-infra.sh"),
          "utf8"
        );
        const preflight = deploySource.match(
          /^verify_cadvisor_topology\(\) \{[\s\S]*?^\}/m
        )?.[0];
        if (!preflight)
          throw new Error("Declared collector topology preflight missing");
        const topologyInvocation = deploySource.indexOf(
          "  verify_cadvisor_topology\n"
        );
        expect(topologyInvocation).toBeGreaterThan(0);
        expect(topologyInvocation).toBeLessThan(
          deploySource.indexOf("$RUNTIME_COMPOSE up -d postgres")
        );
        const verifyTopology = (
          collector: StartedTestContainer,
          topology: string
        ) =>
          collector.exec([
            "/bin/sh",
            "-c",
            `native_topology="$1"
 docker() { printf '%s\\n' "$native_topology"; }
 ${preflight}
 verify_cadvisor_topology`,
            "owned-topology-proof",
            topology,
          ]);
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
            dockerRootDir: host.DockerRootDir,
            storageDriver: host.Driver,
            scope: "CI host only; production cgroup topology is not inferred",
          })
        );
        const actor = async (service: string) => {
          const container = await new GenericContainer(
            services["repo-init"].image
          )
            .withNetwork(network)
            .withLabels({
              "com.docker.compose.service": service,
              "cogni.native-proof": token,
            })
            .withEntrypoint(["/bin/sh", "-c"])
            .withCommand(["sleep 420"])
            .withWaitStrategy(Wait.forSuccessfulCommand("test -d /tmp"))
            .start();
          owned.push(container);
          return container;
        };
        const writer = await actor(writerService);
        const idle = await actor(idleService);
        // Native Engine rejection and repeated filesystem readback prove the long
        // bind cannot silently manufacture an empty source directory.
        const missingSource = `/tmp/cogni-cadvisor-missing-${token}`;
        expect(existsSync(missingSource)).toBe(false);
        for (let attempt = 0; attempt < 2; attempt++) {
          let unexpected: Docker.Container | undefined;
          try {
            await expect(
              docker
                .createContainer({
                  Image: services["repo-init"].image,
                  Labels: { "cogni.native-proof": token },
                  HostConfig: {
                    Mounts: [
                      {
                        Type: "bind",
                        Source: missingSource,
                        Target: "/owned-missing-source",
                        ReadOnly: true,
                      },
                    ],
                  },
                })
                .then((container) => {
                  unexpected = container;
                })
            ).rejects.toThrow(/bind source path does not exist/);
            expect(existsSync(missingSource)).toBe(false);
          } finally {
            if (unexpected) await unexpected.remove({ force: true });
          }
        }
        console.info("CADVISOR_NATIVE_MISSING_SOURCE", {
          attempts: 2,
          directoryCreated: existsSync(missingSource),
        });
        // Model only the supported topology declared by the real deployment preflight.
        expect(host.Driver).toBe("overlay2");
        expect(host.DockerRootDir).toBe("/var/lib/docker");
        const startCollector = async (hostCgroup: boolean) => {
          const collector = hostCgroup
            ? new HostCgroupContainer(alloyService.image, metadataPath)
            : new GenericContainer(alloyService.image);
          const started = await collector
            .withNetwork(network)
            .withUser(alloyService.user ?? "")
            .withBindMounts(
              mounts.filter((mount) => mount.target !== metadataPath)
            )
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
                  if (text.includes(signature)) {
                    collectorErrorClasses.add(signature);
                    for (const line of text.split("\n"))
                      if (line.includes(signature) && collectorErrors.size < 6)
                        collectorErrors.add(
                          line
                            .replace(/[a-f0-9]{64}/g, "<container-id>")
                            .slice(0, 600)
                        );
                  }
              });
            })
            .withWaitStrategy(Wait.forHttp("/-/ready", 12345))
            .withStartupTimeout(90_000)
            .start();
          owned.push(started);
          const inspected = await docker
            .getContainer(started.getId())
            .inspect();
          const actual = Reflect.get(inspected.HostConfig, "CgroupnsMode");
          console.info("CADVISOR_NATIVE_NAMESPACE", {
            hostCgroup,
            actual,
            readonlyMetadataPath: hostCgroup ? metadataPath : null,
          });
          expect(actual).toBe(hostCgroup ? "host" : "private");
          if (hostCgroup)
            expect(
              inspected.Mounts.find(
                (mount) => mount.Destination === metadataPath
              )
            ).toMatchObject({
              Source: metadataPath,
              Destination: metadataPath,
              RW: false,
            });
          return started;
        };
        const alloy = await startCollector(false);
        // Native Docker identity is read above; only its CLI transport is supplied
        // to the owned image. Directory checks execute against actual bind mounts.
        const topology = `${host.DockerRootDir}|${host.Driver}`;
        const missing = await verifyTopology(alloy, topology);
        expect(missing.exitCode).not.toBe(0);
        expect(missing.output).toContain("cadvisor_metadata_path_missing");
        const raw = async (collector = alloy) => {
          const base = `http://${collector.getHost()}:${collector.getMappedPort(12345)}`;
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
          () => raw(),
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
              /^(container_(cpu_usage_seconds_total|memory_working_set_bytes|memory_failures_total|fs_(reads|writes)_bytes_total|blkio_device_usage_total))$/.test(
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
        console.info("CADVISOR_BASELINE_ERROR_PATHS", [...collectorErrors]);
        expect(
          actualRootOnly,
          "Declared baseline no longer reproduces root-only coverage"
        ).toBe(true);
        await alloy.stop();
        owned.splice(owned.indexOf(alloy), 1);
        collectorErrors.clear();
        const variant = await startCollector(alloyService.cgroup === "host");
        const supported = await verifyTopology(variant, topology);
        expect(supported.exitCode, supported.output).toBe(0);
        const unsupported = await verifyTopology(
          variant,
          "/unsupported|overlay2"
        );
        expect(unsupported.exitCode).not.toBe(0);
        expect(unsupported.output).toContain("cadvisor_topology_unsupported");
        console.info("CADVISOR_TOPOLOGY_CONTROLS", {
          supported: supported.output.trim(),
          missing: missing.exitCode,
          unsupported: unsupported.exitCode,
        });
        // An idle cgroup may omit zero-valued I/O series. Establish a real
        // counter with an owned finite fsync, then measure a distinct write.
        const warmup = await writer.exec([
          "/bin/sh",
          "-c",
          "dd if=/dev/zero of=/tmp/cadvisor-warmup bs=1M count=1 conv=fsync",
        ]);
        expect(warmup.exitCode, warmup.output).toBe(0);
        const visible = await poll(
          () => raw(variant),
          (rows) =>
            coverage(rows, writer, writerService) &&
            coverage(rows, idle, idleService) &&
            (writeBytes(actorRows(rows, writer)) ?? -1) >= 1_048_576,
          65_000
        );
        console.info(
          "CADVISOR_HOST_CGROUP_METADATA_RAW",
          JSON.stringify(evidence(visible))
        );
        console.info("CADVISOR_HOST_CGROUP_METADATA_ERROR_PATHS", [
          ...collectorErrors,
        ]);
        // Explicit sensitivity control: visible root series are never counted as actors.
        const rootOnly = before.filter((row) => row.labels.id === "/");
        expect(coverage(rootOnly, writer, writerService)).toBe(false);
        expect(coverage(rootOnly, idle, idleService)).toBe(false);
        expect(
          coverage(visible, writer, writerService),
          "Missing raw owned writer identity; inspect collector scope before relabeling"
        ).toBe(true);
        expect(
          coverage(visible, idle, idleService),
          "Missing raw owned idle identity; this is not two-actor coverage"
        ).toBe(true);
        for (const actor of [writer, idle])
          expect(
            actorRows(visible, actor).some(
              (row) =>
                row.name === "container_memory_failures_total" &&
                row.labels.failure_type === "pgmajfault" &&
                row.labels.scope === "container"
            )
          ).toBe(true);
        expect(config).toContain("container_memory_failures_total");
        const baseline = writeBytes(actorRows(visible, writer));
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
          () => raw(variant),
          (rows) =>
            (writeBytes(actorRows(rows, writer)) ?? -1) >=
            (baseline ?? 0) + 16_777_216,
          65_000
        );
        console.info(
          "CADVISOR_AFTER_FSYNC_RAW",
          JSON.stringify(evidence(after))
        );
        expect(
          writeBytes(actorRows(after, writer)),
          "Finite fsync write had no actor-attributed exporter delta"
        ).toBeGreaterThanOrEqual((baseline ?? 0) + 16_777_216);
      } finally {
        // No faults or writes target another container; attempt all owned cleanup.
        for (const container of owned.reverse()) {
          cleanup.push(...(await Promise.allSettled([container.stop()])));
        }
        cleanup.push(...(await Promise.allSettled([network.stop()])));
      }
      const failed = cleanup.filter((result) => result.status === "rejected");
      expect(failed, "Owned native fixture cleanup failed").toEqual([]);
    }, 360_000);
  }
);
