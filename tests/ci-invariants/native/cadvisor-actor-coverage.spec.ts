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

function actorRows(rows: Sample[], actor: { getId(): string }): Sample[] {
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

function coverage(rows: Sample[], actor: { getId(): string }, service: string) {
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
        // Base Compose must remain independent of observer-native topology.
        expect(
          (alloyService.volumes ?? []).every(
            (volume) => typeof volume === "string"
          )
        ).toBe(true);
        const deploySource = readFileSync(
          path.resolve(runtime, "../../../scripts/ci/deploy-infra.sh"),
          "utf8"
        );
        const bindingTemplate = deploySource.match(
          /<<CADVISOR_COMPOSE\n([\s\S]*?)^CADVISOR_COMPOSE/m
        )?.[1];
        if (!bindingTemplate)
          throw new Error("Actual observability override absent");
        const metadata = yaml.parse(
          bindingTemplate
            .replace("${CADVISOR_BIND_SOURCE}", metadataPath)
            .replace("${CADVISOR_BIND_TARGET}", metadataPath)
        ).services.alloy.volumes[0];
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
              : [metadataPath, metadataPath, volume.read_only ? "ro" : "rw"];
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
        const preflight = deploySource.match(
          /^verify_cadvisor_topology\(\) \{[\s\S]*?^\}/m
        )?.[0];
        if (!preflight)
          throw new Error("Declared collector topology preflight missing");
        const topologyInvocation = deploySource.indexOf(
          "\n  install_cadvisor_binding\n"
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
            : new GenericContainer("grafana/alloy:v1.9.2");
          const started = await collector
            .withNetwork(network)
            .withUser(alloyService.user ?? "")
            .withBindMounts(
              mounts.filter((mount) => mount.target !== metadataPath)
            )
            .withTmpFs({ "/var/lib/alloy": "rw" })
            .withCopyContentToContainer([
              {
                content: `${hostCgroup ? exporter : exporter?.replace(/^\s+containerd_host\s*=.*\n/m, "")}\n`,
                target: "/etc/alloy/config.alloy",
              },
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
        const containerd = (
          host as unknown as {
            Containerd?: {
              Address?: string;
              Namespaces?: { Containers?: string; Plugins?: string };
            };
          }
        ).Containerd;
        const topology = `${host.DockerRootDir}|${host.Driver}|${containerd?.Address ?? ""}|${containerd?.Namespaces?.Containers ?? ""}|${containerd?.Namespaces?.Plugins ?? ""}`;
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
          "/unsupported|overlay2|/run/containerd/containerd.sock|moby|plugins.moby"
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
        expect(
          baseline,
          "Owned fsync warmup was not observed"
        ).toBeGreaterThanOrEqual(1_048_576);
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
    it("compares the old collector with containerd-aware Alloy on actual Docker29 overlayfs", async () => {
      // Privilege belongs only to this disposable nested daemon, never Alloy/runtime declarations.
      const daemonImage =
        "docker:29.1.5-dind@sha256:3a33fc81fa4d38360f490f5b900e9846f725db45bb1d9b1fe02d849bd42a5cf2";
      class OwnedSnapshotterDaemon extends GenericContainer {
        constructor(image: string) {
          super(image);
          Object.assign(this.hostConfig, { CgroupnsMode: "host" });
        }
      }
      const nested = await new OwnedSnapshotterDaemon(daemonImage)
        .withPrivilegedMode()
        .withEnvironment({ DOCKER_TLS_CERTDIR: "" })
        .withCopyContentToContainer([
          {
            content: JSON.stringify({
              features: { "containerd-snapshotter": true },
              "storage-driver": "overlayfs",
            }),
            target: "/etc/docker/daemon.json",
          },
        ])
        .withWaitStrategy(Wait.forSuccessfulCommand("docker info >/dev/null"))
        .withStartupTimeout(180_000)
        .start();
      const ids: string[] = [];
      const cli = async (...args: string[]) => {
        const result = await nested.exec(["docker", ...args]);
        expect(result.exitCode, result.output.slice(-3000)).toBe(0);
        return result.stdout.trim();
      };
      try {
        const info = JSON.parse(
          await cli("info", "--format", "{{json .}}")
        ) as {
          DockerRootDir: string;
          Driver: string;
          DriverStatus: string[][];
          CgroupDriver: string;
          CgroupVersion: string;
          ServerVersion: string;
          Containerd?: {
            Address?: string;
            Namespaces?: { Containers?: string; Plugins?: string };
          };
        };
        expect(info.Driver).toBe("overlayfs");
        expect(info.DriverStatus).toContainEqual([
          "driver-type",
          "io.containerd.snapshotter.v1",
        ]);
        expect(info.ServerVersion).toBe("29.1.5");
        const socket = info.Containerd?.Address;
        expect(socket).toMatch(/^\/(?:run|var\/run)\/.*containerd\.sock$/);
        expect(info.Containerd?.Namespaces?.Containers).toBe("moby");
        expect(info.Containerd?.Namespaces?.Plugins).toBe("plugins.moby");
        if (!socket)
          throw new Error("Actual Docker-managed containerd socket absent");
        const socketCheck = await nested.exec(["test", "-S", socket]);
        expect(socketCheck.exitCode).toBe(0);
        console.info("CADVISOR_OVERLAYFS_NATIVE_TOPOLOGY", {
          daemonImage,
          DockerRootDir: info.DockerRootDir,
          Driver: info.Driver,
          DriverStatus: info.DriverStatus,
          CgroupDriver: info.CgroupDriver,
          CgroupVersion: info.CgroupVersion,
          ServerVersion: info.ServerVersion,
          Containerd: info.Containerd,
        });
        const token = randomUUID();
        const actor = async (service: string) => {
          const id = await cli(
            "run",
            "-d",
            "--label",
            `com.docker.compose.service=${service}`,
            "busybox:1.37",
            "sh",
            "-c",
            "sleep 540"
          );
          ids.push(id);
          return { getId: () => id };
        };
        const writerService = `overlayfs-writer-${token}`;
        const idleService = `overlayfs-idle-${token}`;
        const writer = await actor(writerService);
        const idle = await actor(idleService);
        const fullConfig = readFileSync(
          path.join(runtime, "configs/alloy-config.metrics.alloy"),
          "utf8"
        );
        const component = fullConfig.match(
          /^prometheus\.exporter\.cadvisor "default" \{\n[^{}]*^\}/m
        )?.[0];
        if (!component) throw new Error("Actual exporter component missing");
        const oldConfig = `${component.replace(/^\s+containerd_host\s*=.*\n/m, "")}\n`;
        const nextConfig = `${component}\n`;
        const declaredSocketTarget = "/run/cogni-docker-containerd.sock";
        expect(component).toContain(
          `containerd_host              = "${declaredSocketTarget}"`
        );
        expect(services.alloy.image).toBe("grafana/alloy:v1.14.0");
        const deploySource = readFileSync(
          path.resolve(runtime, "../../../scripts/ci/deploy-infra.sh"),
          "utf8"
        );
        const preflight = deploySource.match(
          /^verify_cadvisor_topology\(\) \{[\s\S]*?^\}/m
        )?.[0];
        const installBinding = deploySource.match(
          /^install_cadvisor_binding\(\) \{[\s\S]*?^\}/m
        )?.[0];
        const fullOnlyGate = deploySource.match(
          /^if \[\[ "\$\{K8S_SECRETS_ONLY:-false\}" != "true" \]\]; then\n {2}# Stable config path[\s\S]*?^fi/m
        )?.[0];
        if (!preflight || !installBinding || !fullOnlyGate)
          throw new Error("Actual normal native observer gate absent");
        const nativePreflight = await nested.exec([
          "/bin/sh",
          "-c",
          `${preflight}\nverify_cadvisor_topology`,
        ]);
        const foreignNamespace = await nested.exec([
          "/bin/sh",
          "-c",
          `native_identity="$1"; docker() { printf '%s\\n' "$native_identity"; }\n${preflight}\nverify_cadvisor_topology`,
          "owned-namespace-negative",
          `${info.DockerRootDir}|${info.Driver}|${socket}|foreign|plugins.moby`,
        ]);
        expect(foreignNamespace.exitCode).not.toBe(0);
        expect(foreignNamespace.output).toContain(
          "cadvisor_native_namespace_unsupported"
        );
        expect(nativePreflight.exitCode, nativePreflight.output).toBe(0);
        expect(nativePreflight.output).toContain(
          `source=${socket} target=${declaredSocketTarget}`
        );
        console.info(
          "CADVISOR_OVERLAYFS_NATIVE_PREFLIGHT",
          nativePreflight.output.trim()
        );
        // Materialize through the owned daemon's live namespace, then read back
        // exact bytes before asking that daemon to bind the files into children.
        for (const [content, target] of [
          [oldConfig, "/tmp/cadvisor-old.alloy"],
          [nextConfig, "/tmp/cadvisor-next.alloy"],
          [fullConfig, "/tmp/cadvisor-full-declared.alloy"],
          [
            readFileSync(path.join(runtime, "docker-compose.yml"), "utf8"),
            "/tmp/runtime-base.yml",
          ],
          [
            "PORT=3000\nDATABASE_URL=postgres://owned:owned@postgres/owned\nDATABASE_SERVICE_URL=postgres://owned:owned@postgres/owned\nAPP_IMAGE=busybox:1.37\nSCHEDULER_WORKER_IMAGE=busybox:1.37\n",
            "/tmp/owned.env",
          ],
        ]) {
          const result = await nested.exec([
            "/bin/sh",
            "-c",
            'umask 022; printf \'%s\' "$1" > "$2"; test -f "$2" && sha256sum "$2"',
            "owned-collector-config",
            content,
            target,
          ]);
          expect(result.exitCode, result.output).toBe(0);
          const digest = createHash("sha256").update(content).digest("hex");
          expect(result.stdout.trim().split(/\s+/)[0]).toBe(digest);
          console.info("CADVISOR_OVERLAYFS_CONFIG_MATERIALIZED", {
            target,
            sha256: digest,
          });
        }
        // Execute the real full-only gate and atomic installer in this owned VM.
        const bindingPath = "/tmp/docker-compose.observability.yml";
        const install = await nested.exec([
          "/bin/sh",
          "-c",
          `${preflight}\n${installBinding}\nCADVISOR_OVERRIDE_FILE="$1"\ninstall_cadvisor_binding`,
          "owned-observer-install",
          bindingPath,
        ]);
        expect(install.exitCode, install.output).toBe(0);
        const bindingBefore = await nested.exec(["sha256sum", bindingPath]);
        const failedInstall = await nested.exec([
          "/bin/sh",
          "-c",
          `${preflight}\n${installBinding}\ndocker() { printf '%s\\n' '/unsupported|overlayfs|/missing|moby|plugins.moby'; }\nCADVISOR_OVERRIDE_FILE="$1"\ninstall_cadvisor_binding`,
          "owned-observer-refusal",
          bindingPath,
        ]);
        expect(failedInstall.exitCode).not.toBe(0);
        expect(failedInstall.output).toContain("cadvisor_topology_unsupported");
        expect((await nested.exec(["sha256sum", bindingPath])).stdout).toBe(
          bindingBefore.stdout
        );
        const k8sOnly = await nested.exec([
          "/bin/sh",
          "-c",
          `K8S_SECRETS_ONLY=true\nRUNTIME_COMPOSE=unused\ninstall_cadvisor_binding() { echo forbidden_observer_dependency; return 91; }\n${fullOnlyGate}\n[ -z "$RUNTIME_OBSERVABILITY_ARGS" ]`,
          "owned-k8s-only",
        ]);
        expect(k8sOnly.exitCode, k8sOnly.output).toBe(0);
        expect(k8sOnly.output).not.toContain("forbidden_observer_dependency");
        await cli(
          "compose",
          "--env-file",
          "/tmp/owned.env",
          "-f",
          "/tmp/runtime-base.yml",
          "--profile",
          "bootstrap",
          "config",
          "--quiet"
        );
        console.info("CADVISOR_OBSERVER_FAILURE_ISOLATION", {
          priorOverrideUnchanged: true,
          baseParseable: true,
          k8sOnlyIndependent: true,
        });
        const dummyEnvironment = [
          ...new Set(
            [...fullConfig.matchAll(/sys\.env\("([A-Z_]+)"\)/g)].map(
              (match) => match[1]
            )
          ),
        ].flatMap((name) => [
          "-e",
          `${name}=${
            name.endsWith("_URL")
              ? "http://127.0.0.1:9/owned-validation"
              : name === "DEPLOY_ENVIRONMENT"
                ? "candidate-a"
                : name === "COGNI_DEFAULT_NODE_ID"
                  ? token
                  : "owned-dummy"
          }`,
        ]);
        await cli(
          "run",
          "--rm",
          "--network=none",
          ...dummyEnvironment,
          "--mount",
          "type=bind,source=/tmp/cadvisor-full-declared.alloy,target=/etc/alloy/full.alloy,readonly",
          "grafana/alloy:v1.14.0",
          "validate",
          "/etc/alloy/full.alloy"
        );
        console.info("CADVISOR_NEW_FULL_CONFIG_VALIDATED", {
          image: "grafana/alloy:v1.14.0",
          network: "none",
          sourceSha256: createHash("sha256").update(fullConfig).digest("hex"),
        });
        // Docker Compose must leave every owned core service untouched when the
        // stable observability config path is introduced for the first time.
        const composeProject = `observer-${token}`;
        const composeBase = "/tmp/owned-core.yml";
        const coreConfig = yaml.stringify({
          services: {
            postgres: {
              image: services.postgres.image,
              environment: { POSTGRES_PASSWORD: "owned-native-only" },
            },
            doltgres: {
              image: services.doltgres.image,
              environment: { DOLTGRES_PASSWORD: "owned-native-only" },
            },
            redis: { image: services.redis.image },
            alloy: {
              image: services.alloy.image,
              user: services.alloy.user,
              cgroup: services.alloy.cgroup,
              command: [
                "run",
                "/etc/alloy/config.alloy",
                "--server.http.listen-addr=0.0.0.0:12345",
              ],
              volumes: [
                "/tmp/cadvisor-next.alloy:/etc/alloy/config.alloy:ro",
                "/var/run/docker.sock:/var/run/docker.sock:ro",
                "/proc:/host/proc:ro",
                "/sys:/host/sys:ro",
                "/:/host/root:ro",
              ],
            },
          },
        });
        const writeCore = await nested.exec([
          "/bin/sh",
          "-c",
          `printf '%s' "$1" > "$2"`,
          "owned-compose-proof",
          coreConfig,
          composeBase,
        ]);
        expect(writeCore.exitCode, writeCore.output).toBe(0);
        const composeArgs = [
          "compose",
          "--project-name",
          composeProject,
          "-f",
          composeBase,
        ];
        await cli(...composeArgs, "up", "-d");
        const coreIdentity = async () => {
          const identities: Record<string, { id: string; startedAt: string }> =
            {};
          for (const service of ["postgres", "doltgres", "redis", "alloy"]) {
            const id = await cli(...composeArgs, "ps", "-q", service);
            expect(id).toMatch(/^[a-f0-9]{64}$/);
            ids.push(id);
            const state = JSON.parse(await cli("inspect", id))[0] as {
              Id: string;
              State: { Running: boolean; StartedAt: string };
            };
            expect(state.State.Running, service).toBe(true);
            identities[service] = {
              id: state.Id,
              startedAt: state.State.StartedAt,
            };
          }
          return identities;
        };
        const coreBefore = await coreIdentity();
        await cli(...composeArgs, "-f", bindingPath, "up", "-d");
        const coreAfter = await coreIdentity();
        for (const service of ["postgres", "doltgres", "redis"])
          expect(
            coreAfter[service],
            `${service} was recreated by observer-only config`
          ).toEqual(coreBefore[service]);
        expect(coreAfter.alloy.id).not.toBe(coreBefore.alloy.id);
        console.info("CADVISOR_FIRST_OVERRIDE_CORE_IDENTITIES", {
          before: coreBefore,
          after: coreAfter,
        });
        await cli(...composeArgs, "-f", bindingPath, "down", "--volumes");
        const launch = async (
          image: string,
          config: string,
          withSocket: boolean
        ) => {
          const args = [
            "run",
            "-d",
            "--cgroupns=host",
            "--user=0:0",
            "--mount",
            "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock,readonly",
            "--mount",
            "type=bind,source=/proc,target=/host/proc,readonly",
            "--mount",
            "type=bind,source=/sys,target=/host/sys,readonly",
            "--mount",
            "type=bind,source=/,target=/host/root,readonly",
            "--mount",
            `type=bind,source=${config},target=/etc/alloy/config.alloy,readonly`,
            "-p",
            "127.0.0.1::12345",
          ];
          if (withSocket)
            args.push(
              "--mount",
              `type=bind,source=${socket},target=${declaredSocketTarget},readonly`
            );
          args.push(
            image,
            "run",
            "--server.http.listen-addr=0.0.0.0:12345",
            "/etc/alloy/config.alloy"
          );
          const id = await cli(...args);
          ids.push(id);
          const inspected = JSON.parse(await cli("inspect", id))[0] as {
            HostConfig: { CgroupnsMode: string };
            Mounts: { Source: string; Destination: string; RW: boolean }[];
            NetworkSettings: { Ports: Record<string, { HostPort: string }[]> };
          };
          expect(inspected.HostConfig.CgroupnsMode).toBe("host");
          expect(
            inspected.Mounts.some((m) => m.Source.includes("layerdb"))
          ).toBe(false);
          if (withSocket)
            expect(
              inspected.Mounts.find(
                (m) => m.Destination === declaredSocketTarget
              )?.RW
            ).toBe(false);
          const port =
            inspected.NetworkSettings.Ports["12345/tcp"]?.[0]?.HostPort;
          if (!port) throw new Error("Actual collector endpoint missing");
          return {
            id,
            raw: async () => {
              const result = await nested.exec([
                "wget",
                "-qO-",
                `http://127.0.0.1:${port}/api/v0/component/prometheus.exporter.cadvisor.default/metrics`,
              ]);
              return result.exitCode === 0 ? samples(result.stdout) : [];
            },
          };
        };
        const old = await launch(
          "grafana/alloy:v1.9.2",
          "/tmp/cadvisor-old.alloy",
          false
        );
        const baseline = await poll(
          old.raw,
          (rows) =>
            coverage(rows, writer, writerService) &&
            coverage(rows, idle, idleService),
          65_000
        );
        const oldLogs = await nested.exec(["docker", "logs", old.id]);
        console.info("CADVISOR_OVERLAYFS_OLD_CONTROL", {
          actors: [
            actorRows(baseline, writer).length,
            actorRows(baseline, idle).length,
          ],
          rootPresent: baseline.some((row) => row.labels.id === "/"),
          errors: oldLogs.output
            .split("\n")
            .filter((line) => /error|failed|mount-id/i.test(line))
            .slice(-6)
            .map((line) => line.slice(0, 600)),
        });
        expect(
          baseline.some((row) => row.labels.id === "/"),
          "Old collector never exposed actual root metrics"
        ).toBe(true);
        expect(actorRows(baseline, writer)).toEqual([]);
        expect(actorRows(baseline, idle)).toEqual([]);
        await cli("stop", old.id);
        const next = await launch(
          services.alloy.image,
          "/tmp/cadvisor-next.alloy",
          true
        );
        const missingSocket = await nested.exec([
          "docker",
          "exec",
          next.id,
          "/bin/sh",
          "-c",
          `native_identity="$1"; docker() { printf '%s\\n' "$native_identity"; }\n${preflight}\nverify_cadvisor_topology`,
          "owned-socket-negative",
          `${info.DockerRootDir}|${info.Driver}|${socket}|moby|plugins.moby`,
        ]);
        expect(missingSocket.exitCode).not.toBe(0);
        expect(missingSocket.output).toContain(
          "cadvisor_native_socket_missing"
        );
        console.info("CADVISOR_OVERLAYFS_NEGATIVE_CONTROLS", {
          foreignNamespace: foreignNamespace.exitCode,
          sourceSocketMissingInCollector: missingSocket.exitCode,
        });
        await cli(
          "exec",
          writer.getId(),
          "sh",
          "-c",
          "dd if=/dev/zero of=/tmp/warmup bs=1M count=1 conv=fsync"
        );
        const visible = await poll(
          next.raw,
          (rows) =>
            coverage(rows, writer, writerService) &&
            coverage(rows, idle, idleService) &&
            (writeBytes(actorRows(rows, writer)) ?? -1) >= 1_048_576,
          65_000
        );
        expect(coverage(visible, writer, writerService)).toBe(true);
        expect(coverage(visible, idle, idleService)).toBe(true);
        const before = writeBytes(actorRows(visible, writer));
        expect(before).toBeGreaterThanOrEqual(1_048_576);
        for (const owned of [writer, idle])
          expect(
            actorRows(visible, owned).some(
              (row) =>
                row.name === "container_memory_failures_total" &&
                row.labels.failure_type === "pgmajfault" &&
                row.labels.scope === "container"
            )
          ).toBe(true);
        await cli(
          "exec",
          writer.getId(),
          "sh",
          "-c",
          "dd if=/dev/zero of=/tmp/proof bs=1M count=16 conv=fsync"
        );
        const after = await poll(
          next.raw,
          (rows) =>
            (writeBytes(actorRows(rows, writer)) ?? -1) >=
            (before ?? 0) + 16_777_216,
          65_000
        );
        const written = writeBytes(actorRows(after, writer));
        console.info("CADVISOR_OVERLAYFS_NEW_RESULT", {
          image: "grafana/alloy:v1.14.0",
          socket,
          namespace: info.Containerd?.Namespaces,
          actors: [writer, idle].map((owned) => ({
            id: owned.getId(),
            metrics: actorRows(after, owned).map((row) => ({
              name: row.name,
              value: row.value,
              service: row.labels.container_label_com_docker_compose_service,
              device: row.labels.device,
            })),
          })),
          before,
          after: written,
        });
        expect(written).toBeGreaterThanOrEqual((before ?? 0) + 16_777_216);
      } finally {
        for (const id of ids.reverse())
          await nested.exec(["docker", "rm", "-f", id]).catch(() => undefined);
        await nested.stop();
      }
    }, 600_000);
  }
);
