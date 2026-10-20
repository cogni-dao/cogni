// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/native/litellm-readiness-recovery`
 * Purpose: Prove normal Compose removes LiteLLM's health-restart amplifier.
 * Scope: CI-owned real gateway and databases. Does not access deployed hosts or credentials.
 * Invariants: Real old-policy restart; exact declared probe and exit policy; one normal stateless replacement; database identities survive.
 * Side-effects: IO (owned containers/network/files and bounded process-limit fault), time (readiness deadlines).
 * Links: task.5281, bug.5462, infra/compose/runtime/docker-compose.yml
 * @internal
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

const repo = path.resolve(__dirname, "../../..");
const { services } = yaml.parse(
  readFileSync(
    path.join(repo, "infra/compose/runtime/docker-compose.yml"),
    "utf8"
  )
);
async function until(
  check: () => Promise<boolean>,
  message: string,
  timeout = 180_000
) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await delay(1_000);
  } while (Date.now() < deadline);
  throw new Error(message);
}

// Local execution must not silently count as native acceptance.
if (!process.env.CI)
  console.warn(
    "LiteLLM native policy proof is CI-only; local skip is not a passing runtime proof."
  );
describe.skipIf(!process.env.CI)("LiteLLM normal Compose recovery", () => {
  it("replaces the old true-policy gateway once and preserves native databases", async () => {
    const docker = new Docker({ timeout: 10_000 });
    await docker.ping();
    const project = `cogni-litellm-${randomUUID().slice(0, 8)}`;
    const selector = `${project}-watchdog`;
    const directory = mkdtempSync(path.join(tmpdir(), `${project}-`));
    const composeFile = path.join(directory, "compose.yaml");
    const configFile = path.join(directory, "litellm.yaml");
    const network = await new Network().start();
    const owned: StartedTestContainer[] = [];
    let watchdog: StartedTestContainer | undefined;
    const compose = (...args: string[]) =>
      execFileSync(
        "docker",
        ["compose", "--project-name", project, "--file", composeFile, ...args],
        {
          encoding: "utf8",
          timeout: 240_000,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
    try {
      const postgres = await new PostgreSqlContainer(services.postgres.image)
        .withDatabase("litellm")
        .withUsername("litellm")
        .withPassword(randomUUID())
        .withNetwork(network)
        .withNetworkAliases("owned-pg")
        .start();
      owned.push(postgres);
      const dolt = await new GenericContainer(services.doltgres.image)
        .withEnvironment({ DOLTGRES_PASSWORD: randomUUID() })
        .withNetwork(network)
        .withWaitStrategy(Wait.forLogMessage(/server (started|listening)/i))
        .withStartupTimeout(120_000)
        .start();
      owned.push(dolt);
      const databaseState = async () =>
        Promise.all(
          owned.map(async (container) => {
            const state = await docker
              .getContainer(container.getId())
              .inspect();
            return {
              id: state.Id,
              image: state.Image,
              startedAt: state.State.StartedAt,
            };
          })
        );
      const before = await databaseState();
      const pgIdentity = await postgres.exec([
        "sh",
        "-c",
        'LC_ALL=C pg_controldata "$PGDATA"',
      ]);
      expect(pgIdentity.exitCode).toBe(0);
      const systemId = pgIdentity.output.match(
        /^Database system identifier:\s+(\d+)$/m
      )?.[1];
      expect(systemId).toMatch(/^\d+$/);
      const gatewayImage = execFileSync(
        "bash",
        [
          "-c",
          'source "$1"; infra_image_tag litellm',
          "owned-image-resolution",
          path.join(repo, "scripts/ci/lib/image-tags.sh"),
        ],
        { cwd: repo, encoding: "utf8" }
      ).trim();
      expect(gatewayImage).toMatch(/:litellm-[a-f0-9]+$/);
      expect(services.litellm.labels).toContain("autoheal=false");
      expect(services.litellm.restart).toBe("unless-stopped");
      writeFileSync(
        configFile,
        yaml.stringify({
          model_list: [],
          general_settings: {
            database_url: "os.environ/LITELLM_DATABASE_URL",
            master_key: "os.environ/LITELLM_MASTER_KEY",
          },
        })
      );
      const desired = (oldPolicy: boolean) => ({
        services: {
          litellm: {
            image: gatewayImage,
            command: [
              "--config",
              "/app/config.yaml",
              "--host",
              "0.0.0.0",
              "--port",
              "4000",
            ],
            restart: services.litellm.restart,
            healthcheck: services.litellm.healthcheck,
            labels: {
              autoheal: oldPolicy ? "true" : "false",
              [selector]: oldPolicy ? "true" : "false",
            },
            environment: {
              LITELLM_MASTER_KEY: `sk-${randomUUID()}`,
              LITELLM_DATABASE_URL: `postgresql://litellm:${postgres.getPassword()}@owned-pg:5432/litellm`,
            },
            volumes: [`${configFile}:/app/config.yaml:ro`],
            ports: ["127.0.0.1::4000"],
            networks: ["owned"],
          },
        },
        networks: { owned: { external: true, name: network.getName() } },
      });
      // Keep credentials and every input except reviewed policy identical across convergence.
      const declaration = desired(true);
      writeFileSync(composeFile, yaml.stringify(declaration));
      compose("up", "-d", "--no-deps", "litellm");
      const oldId = compose("ps", "-q", "litellm").trim();
      const old = docker.getContainer(oldId);
      await until(
        async () => (await old.inspect()).State.Health?.Status === "healthy",
        "Old gateway never passed the unchanged declared native healthcheck",
        240_000
      );
      const oldInspection = await old.inspect();
      const oldStart = oldInspection.State.StartedAt;
      const exactHealthcheck = oldInspection.Config.Healthcheck;
      watchdog = await new GenericContainer(services.autoheal.image)
        .withEnvironment({
          ...Object.fromEntries(
            services.autoheal.environment.map((entry: string) => {
              const at = entry.indexOf("=");
              return [entry.slice(0, at), entry.slice(at + 1)];
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
      // Native exec transport fault on this owned disposable gateway, without
      // deleting Docker metadata or faulting/restarting either database.
      await old.update({ PidsLimit: 1 });
      await until(
        async () => (await old.inspect()).State.Health?.Status === "unhealthy",
        "Owned exec fault did not fail the declared health probe",
        270_000
      );
      const failedHealth = (await old.inspect()).State.Health;
      expect(failedHealth?.Log.some((entry) => entry.ExitCode !== 0)).toBe(
        true
      );
      await until(
        async () => (await old.inspect()).State.StartedAt !== oldStart,
        "Old true policy did not actually restart its unhealthy gateway",
        120_000
      );
      const actions = (
        await docker
          .getContainer(watchdog.getId())
          .logs({ stdout: true, stderr: true })
      ).toString();
      expect(
        actions
          .split("\n")
          .some(
            (line) =>
              line.includes(oldId.slice(0, 12)) &&
              /unhealthy/i.test(line) &&
              /restart/i.test(line)
          )
      ).toBe(true);
      declaration.services.litellm.labels = {
        autoheal: "false",
        [selector]: "false",
      };
      writeFileSync(composeFile, yaml.stringify(declaration));
      // This is normal desired-state convergence, with no force-recreate mode.
      compose("up", "-d", "--no-deps", "litellm");
      const repairedId = compose("ps", "-q", "litellm").trim();
      expect(repairedId).not.toBe(oldId);
      const repaired = docker.getContainer(repairedId);
      const after = await repaired.inspect();
      expect(after.Config.Healthcheck).toEqual(exactHealthcheck);
      expect(after.Config.Labels.autoheal).toBe("false");
      expect(after.HostConfig.RestartPolicy?.Name).toBe("unless-stopped");
      const repairedStart = after.State.StartedAt;
      await until(
        async () =>
          (await repaired.inspect()).State.Health?.Status === "healthy",
        "Repaired gateway failed bounded native readiness",
        240_000
      );
      const port = (await repaired.inspect()).NetworkSettings.Ports[
        "4000/tcp"
      ]?.[0]?.HostPort;
      expect(port).toBeTruthy();
      const response = await fetch(
        `http://127.0.0.1:${port}/health/readiness`,
        { signal: AbortSignal.timeout(5_000) }
      );
      expect(response.status).toBe(200);
      // Reapply the same native exec fault to the reviewed policy. The process
      // must survive an unhealthy probe while the real watchdog remains active.
      await repaired.update({ PidsLimit: 1 });
      await until(
        async () =>
          (await repaired.inspect()).State.Health?.Status === "unhealthy",
        "Repaired control did not observe the same exec fault",
        270_000
      );
      await delay(15_000);
      expect((await repaired.inspect()).State.StartedAt).toBe(repairedStart);
      await repaired.update({ PidsLimit: after.HostConfig.PidsLimit ?? -1 });
      await until(
        async () =>
          (await repaired.inspect()).State.Health?.Status === "healthy",
        "Same repaired gateway failed readiness after exec transport recovered"
      );
      const recovered = await fetch(
        `http://127.0.0.1:${port}/health/readiness`,
        { signal: AbortSignal.timeout(5_000) }
      );
      expect(recovered.status).toBe(200);
      expect((await repaired.inspect()).State.StartedAt).toBe(repairedStart);
      const finalActions = (
        await docker
          .getContainer(watchdog.getId())
          .logs({ stdout: true, stderr: true })
      ).toString();
      expect(finalActions).not.toContain(repairedId.slice(0, 12));
      expect(await databaseState()).toEqual(before);
      const pgAfter = await postgres.exec([
        "sh",
        "-c",
        'LC_ALL=C pg_controldata "$PGDATA"',
      ]);
      expect(
        pgAfter.output.match(/^Database system identifier:\s+(\d+)$/m)?.[1]
      ).toBe(systemId);
      console.info(
        JSON.stringify({
          proof: "litellm-normal-policy-recovery",
          oldId,
          repairedId,
          readinessStatus: response.status,
          databaseIdentitiesUnchanged: true,
          postgresSystemIdentifier: systemId,
        })
      );
    } finally {
      if (watchdog) await watchdog.stop();
      try {
        if (existsSync(composeFile)) compose("down", "--remove-orphans");
      } finally {
        await Promise.allSettled(
          owned.reverse().map((container) => container.stop())
        );
        await network.stop();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }, 720_000);
});
