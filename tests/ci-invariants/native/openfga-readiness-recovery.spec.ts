// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/native/openfga-readiness-recovery`
 * Purpose: Prove authorization recovery and provisioner isolation from application content.
 * Scope: CI-owned Docker dependencies only. Does not access deployed environments or credentials.
 * Invariants:
 *   - DECLARATION_IS_TESTED: images, health probe, label value and restart policy come from Compose.
 *   - FAILURE_CONTROL: the old true label actually restarts under the same datastore fault.
 *   - PROCESS_SURVIVES: repaired FGA retains StartedAt through failure and successful authorization recovery.
 *   - OWNED_FAULT_ONLY: the unique autoheal selector and paused database belong only to this test.
 *   - PROVISIONING_IS_NOT_CONTENT_WRITE: fresh and repeated provisioning never commit application working sets.
 * Side-effects: IO (CI-owned Docker containers/network; pauses and restores owned Postgres).
 * Links: story.5095, task.5281, docs/spec/cicd-platform-boundary.md
 * @internal
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import Docker from "dockerode";
import {
  GenericContainer,
  Network,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

interface Service {
  image: string;
  labels?: string[];
  environment?: string[];
  restart?: "unless-stopped";
  healthcheck?: {
    test: ["CMD", ...string[]];
    interval: string;
    timeout: string;
    retries: number;
    start_period: string;
  };
}

const { services } = yaml.parse(
  readFileSync(
    path.resolve(
      __dirname,
      "../../../infra/compose/runtime/docker-compose.yml"
    ),
    "utf8"
  )
) as { services: Record<string, Service> };

function image(service: Service): string {
  return service.image.match(/^\$\{[A-Z_]+:-(.+)\}$/)?.[1] ?? service.image;
}

function milliseconds(duration: string): number {
  const match = /^(\d+)(ms|s|m)$/.exec(duration);
  if (!match)
    throw new Error(`Unsupported declared health duration: ${duration}`);
  return (
    Number(match[1]) * (match[2] === "ms" ? 1 : match[2] === "s" ? 1e3 : 60e3)
  );
}

async function until(
  condition: () => Promise<boolean>,
  message: string,
  timeoutMs = 75_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await condition()) return;
    await delay(1_000);
  } while (Date.now() < deadline);
  throw new Error(message);
}

async function post(base: string, endpoint: string, body: unknown) {
  const response = await fetch(`${base}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  expect(response.status, endpoint).toBeLessThan(300);
  return response.status === 204 ? {} : response.json();
}

if (!process.env.CI) {
  console.warn(
    "OpenFGA native readiness fault proof is CI-only and SKIPPED locally; this is not a passing runtime proof."
  );
}

describe.skipIf(!process.env.CI)(
  "OpenFGA dependency readiness recovery",
  () => {
    it("provisions fresh Dolt databases and roles without committing existing application changes", async () => {
      const docker = new Docker({ timeout: 10_000 });
      await docker.ping();
      const network = await new Network().start();
      const owned: StartedTestContainer[] = [];
      const cleanup: PromiseSettledResult<unknown>[] = [];
      try {
        const password = randomUUID();
        const readerPassword = randomUUID();
        const writerPassword = randomUUID();
        const node = `provision_${randomUUID().replaceAll("-", "")}`;
        const database = `knowledge_${node}`;
        const dolt = await new GenericContainer(image(services.doltgres))
          .withEnvironment({ DOLTGRES_PASSWORD: password })
          .withNetwork(network)
          .withNetworkAliases("provision-dolt")
          .withWaitStrategy(Wait.forLogMessage(/server (started|listening)/i))
          .withStartupTimeout(120_000)
          .start();
        owned.push(dolt);
        const client = await new GenericContainer(
          image(services["doltgres-provision"])
        )
          .withEntrypoint(["/bin/sh", "-c"])
          .withCommand(["sleep infinity"])
          .withWaitStrategy(Wait.forSuccessfulCommand("command -v psql"))
          .withNetwork(network)
          .withEnvironment({
            DOLTGRES_HOST: "provision-dolt",
            DOLTGRES_PORT: "5432",
            DOLTGRES_PASSWORD: password,
            DOLTGRES_READER_PASSWORD: readerPassword,
            DOLTGRES_WRITER_PASSWORD: writerPassword,
            COGNI_NODE_DBS: `cogni_${node}`,
          })
          .withCopyFilesToContainer([
            {
              source: path.resolve(
                __dirname,
                "../../../infra/compose/runtime/doltgres-init/provision.sh"
              ),
              target: "/app/provision.sh",
            },
          ])
          .start();
        owned.push(client);
        const provision = async () => {
          const result = await client.exec(["bash", "/app/provision.sh"]);
          expect(result.exitCode, result.output).toBe(0);
        };
        const sql = async (
          query: string,
          user = "postgres",
          secret = password
        ) => {
          const result = await client.exec([
            "env",
            `PGPASSWORD=${secret}`,
            "PGCONNECT_TIMEOUT=5",
            "psql",
            "-XAt",
            "-h",
            "provision-dolt",
            "-p",
            "5432",
            "-U",
            user,
            "-d",
            database,
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            query,
          ]);
          expect(result.exitCode, result.output).toBe(0);
          return result.stdout.trim();
        };
        const head = async () =>
          (await sql("SELECT dolt_hashof('HEAD')"))
            .replace(/^\{/, "")
            .replace(/\}$/, "");

        await provision();
        expect(await head()).toMatch(/^[a-z0-9]{32,64}$/i);
        expect(
          await sql("SELECT current_user", "knowledge_reader", readerPassword)
        ).toBe("knowledge_reader");
        expect(
          await sql("SELECT current_user", "knowledge_writer", writerPassword)
        ).toBe("knowledge_writer");
        // The migrator owns its first schema commit; bootstrap needs no empty commit.
        await sql(
          "CREATE TABLE provision_content_sentinel (id INT PRIMARY KEY, note TEXT)"
        );
        await sql(
          "SELECT dolt_commit('-Am', 'test: migrator owns schema commit')"
        );
        const base = await head();
        await sql(
          "INSERT INTO provision_content_sentinel VALUES (1, 'uncommitted-user-intent')"
        );
        expect(await sql("SELECT COUNT(*) FROM dolt.status")).not.toBe("0");

        await provision();
        expect(await head()).toBe(base);
        expect(
          await sql("SELECT note FROM provision_content_sentinel WHERE id = 1")
        ).toBe("uncommitted-user-intent");
        expect(await sql("SELECT table_name FROM dolt.status")).toContain(
          "provision_content_sentinel"
        );
        // Sensitivity control: the exact retired command commits that same user change.
        await sql("SELECT dolt_commit('-Am', 'provision: database + roles')");
        expect(await head()).not.toBe(base);
        expect(await sql("SELECT COUNT(*) FROM dolt.status")).toBe("0");
      } finally {
        const stopped = await Promise.allSettled(
          owned.reverse().map((container) => container.stop())
        );
        const detached = await Promise.allSettled([network.stop()]);
        cleanup.push(...stopped, ...detached);
      }
      if (cleanup.some((result) => result.status === "rejected"))
        throw new Error("Owned Dolt provisioning fixture cleanup failed");
    }, 300_000);

    it("rejects invalid secret authority before publishing the runtime environment", () => {
      expect(
        execFileSync(
          "bash",
          [
            path.resolve(
              __dirname,
              "../../../scripts/ci/tests/runtime-secret-authority.test.sh"
            ),
          ],
          { encoding: "utf8", timeout: 10_000 }
        )
      ).toContain("runtime-secret-authority:");
    });

    it("survives a PostgreSQL fault while the old autoheal policy demonstrably restarts", async () => {
      // Missing Docker in CI is a failure, never a silent skip.
      const docker = new Docker({ timeout: 10_000 });
      await docker.ping();
      const network = await new Network().start();
      const owned: StartedTestContainer[] = [];
      const cleanup: PromiseSettledResult<unknown>[] = [];
      let postgres: StartedTestContainer | undefined;
      let autoheal: StartedTestContainer | undefined;
      let paused = false;
      try {
        const password = randomUUID();
        postgres = await new PostgreSqlContainer(image(services.postgres))
          .withDatabase("openfga")
          .withUsername("fga_test")
          .withPassword(password)
          .withNetwork(network)
          .withNetworkAliases("fga-pg")
          .start();
        owned.push(postgres);
        // Exercise the exact deploy credential probe against this owned native DB.
        // pg_controldata independently binds the authenticated SQL identity to PGDATA.
        const deploySource = readFileSync(
          path.resolve(__dirname, "../../../scripts/ci/deploy-infra.sh"),
          "utf8"
        );
        const probe = deploySource.match(
          /^postgres_bootstrap_identity\(\) \{[\s\S]*?^\}/m
        )?.[0];
        if (!probe) throw new Error("Normal deploy bootstrap probe is missing");
        const pgContainerId = postgres.getId();
        const pgInspection = await docker.getContainer(pgContainerId).inspect();
        const pgAddress =
          pgInspection.NetworkSettings.Networks[network.getName()].IPAddress;
        const pgControl = await postgres.exec([
          "sh",
          "-c",
          'LC_ALL=C pg_controldata "$PGDATA"',
        ]);
        expect(pgControl.exitCode).toBe(0);
        const systemId = pgControl.output.match(
          /^Database system identifier:\s+(\d+)$/m
        )?.[1];
        expect(systemId).toMatch(/^\d+$/);
        const authenticate = (credential: string) =>
          execFileSync(
            "bash",
            [
              "-c",
              `${probe}\npostgres_bootstrap_identity "$1" "$2" "$3"`,
              "owned-bootstrap-proof",
              pgContainerId,
              pgAddress,
              "fga_test",
            ],
            {
              input: `${credential}\n`,
              encoding: "utf8",
              timeout: 25_000,
              stdio: ["pipe", "pipe", "pipe"],
            }
          ).trim();
        expect(() =>
          authenticate("deliberately-invalid-owned-fixture")
        ).toThrow(/password authentication failed/);
        expect(authenticate(password)).toBe(`${systemId}|fga_test|true`);
        const datastore = {
          OPENFGA_DATASTORE_ENGINE: "postgres",
          OPENFGA_DATASTORE_URI: `postgres://fga_test:${password}@fga-pg:5432/openfga?sslmode=disable`,
        };
        const migration = await new GenericContainer(image(services.openfga))
          .withNetwork(network)
          .withEnvironment(datastore)
          .withCommand(["migrate"])
          .withWaitStrategy(Wait.forOneShotStartup())
          .start();
        owned.push(migration);

        const health = services.openfga.healthcheck;
        if (!health)
          throw new Error("Declared OpenFGA health check is missing");
        const label = services.openfga.labels?.find((value) =>
          value.startsWith("autoheal=")
        );
        expect(label).toBe("autoheal=false");
        expect(services.openfga.restart).toBe("unless-stopped");
        const restart = services.openfga.restart;
        if (!restart) throw new Error("Declared restart policy is missing");
        const healthCheck = {
          test: health.test,
          interval: milliseconds(health.interval),
          timeout: milliseconds(health.timeout),
          retries: health.retries,
          startPeriod: milliseconds(health.start_period),
        };
        const selector = `cogni-fga-fault-${randomUUID()}`;
        async function startFga(value: string) {
          const container = await new GenericContainer(image(services.openfga))
            .withNetwork(network)
            .withEnvironment(datastore)
            .withCommand(["run"])
            .withExposedPorts(8080)
            // Rename only the selector key so no unrelated autoheal can select this control.
            .withLabels({ [selector]: value })
            .withHealthCheck(healthCheck)
            .withWaitStrategy(Wait.forHealthCheck())
            .withStartupTimeout(90_000)
            .start();
          owned.push(container);
          await docker
            .getContainer(container.getId())
            .update({ RestartPolicy: { Name: restart } });
          return container;
        }
        const repaired = await startFga(label?.split("=")[1] ?? "missing");
        const control = await startFga("true");
        const repairedDocker = docker.getContainer(repaired.getId());
        const controlDocker = docker.getContainer(control.getId());
        const repairedStart = (await repairedDocker.inspect()).State.StartedAt;
        const controlStart = (await controlDocker.inspect()).State.StartedAt;
        const base = `http://${repaired.getHost()}:${repaired.getMappedPort(8080)}`;
        const store = await post(base, "/stores", {
          name: "owned-readiness-proof",
        });
        const model = await post(
          base,
          `/stores/${store.id}/authorization-models`,
          {
            schema_version: "1.1",
            type_definitions: [
              { type: "user" },
              {
                type: "document",
                relations: { viewer: { this: {} } },
                metadata: {
                  relations: {
                    viewer: { directly_related_user_types: [{ type: "user" }] },
                  },
                },
              },
            ],
          }
        );
        const tuple = {
          user: "user:test",
          relation: "viewer",
          object: "document:owned",
        };
        await post(base, `/stores/${store.id}/write`, {
          authorization_model_id: model.authorization_model_id,
          writes: { tuple_keys: [tuple] },
        });
        const allowed = async () =>
          (
            await post(base, `/stores/${store.id}/check`, {
              authorization_model_id: model.authorization_model_id,
              tuple_key: tuple,
            })
          ).allowed === true;
        expect(await allowed()).toBe(true);

        await docker.getContainer(postgres.getId()).pause();
        paused = true;
        await until(
          async () =>
            (await repairedDocker.inspect()).State.Health?.Status ===
            "unhealthy",
          "Datastore fault never reached the declared OpenFGA health check"
        );
        await until(
          async () =>
            (await controlDocker.inspect()).State.Health?.Status ===
            "unhealthy",
          "True-label control never became unhealthy under the same datastore fault"
        );
        expect((await repairedDocker.inspect()).State.StartedAt).toBe(
          repairedStart
        );
        expect((await controlDocker.inspect()).State.StartedAt).toBe(
          controlStart
        );
        autoheal = await new GenericContainer(image(services.autoheal))
          .withEnvironment({
            ...Object.fromEntries(
              (services.autoheal.environment ?? []).map((entry) => {
                const equals = entry.indexOf("=");
                if (equals < 1)
                  throw new Error("Autoheal environment must be explicit");
                return [entry.slice(0, equals), entry.slice(equals + 1)];
              })
            ),
            AUTOHEAL_CONTAINER_LABEL: selector,
          })
          .withNetworkMode("none")
          .withBindMounts([
            {
              source: "/var/run/docker.sock",
              target: "/var/run/docker.sock",
              mode: "ro",
            },
          ])
          .start();
        await until(
          async () =>
            (await controlDocker.inspect()).State.StartedAt !== controlStart,
          "True-label control never restarted; fault sensitivity is unproven",
          120_000 // Includes the unchanged declared autoheal startup grace.
        );
        const autohealLog = await docker
          .getContainer(autoheal.getId())
          .logs({ stdout: true, stderr: true });
        const log = autohealLog.toString();
        expect(
          log
            .split("\n")
            .some(
              (line) =>
                line.includes(control.getId().slice(0, 12)) &&
                /unhealthy/i.test(line) &&
                /restart/i.test(line)
            ),
          "Autoheal must name the unhealthy control in its restart action"
        ).toBe(true);
        expect(log).not.toContain(repaired.getId().slice(0, 12));
        expect((await repairedDocker.inspect()).State.StartedAt).toBe(
          repairedStart
        );
        expect((await repairedDocker.inspect()).State.Health?.Status).toBe(
          "unhealthy"
        );

        await docker.getContainer(postgres.getId()).unpause();
        paused = false;
        await until(
          async () =>
            (await repairedDocker.inspect()).State.Health?.Status === "healthy",
          "Same OpenFGA process did not recover readiness after PostgreSQL resumed"
        );
        expect(await allowed()).toBe(true);
        expect((await repairedDocker.inspect()).State.StartedAt).toBe(
          repairedStart
        );
      } finally {
        // Stop the only Docker-socket actor before cleanup; never fault a deployed database.
        if (autoheal)
          cleanup.push(...(await Promise.allSettled([autoheal.stop()])));
        if (paused && postgres)
          cleanup.push(
            ...(await Promise.allSettled([
              docker.getContainer(postgres.getId()).unpause(),
            ]))
          );
        cleanup.push(
          ...(await Promise.allSettled(
            owned.reverse().map((container) => container.stop())
          ))
        );
        cleanup.push(...(await Promise.allSettled([network.stop()])));
      }
      const failures = cleanup.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Owned fault fixture cleanup failed"
        );
    }, 300_000);
  }
);
