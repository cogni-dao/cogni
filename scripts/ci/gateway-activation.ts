// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `scripts/ci/gateway-activation`
 * Purpose: Trusted native transport for the one gateway activation state machine.
 * Scope: Fixed workflow, custodian, host paths and provider target; candidate bootstrap only.
 * Invariants: Complete producer inventory; exact source; private host-held credentials;
 *   one SSH connection and guard across the transaction; typed nonsecret receipt only.
 * Side-effects: GitHub reads, guard-library enrollment and fixed SSH host operations.
 * Links: bug.5570
 * @internal
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  activateGateway,
  type GatewayHostPort,
  type GatewayIntent,
  GatewayIntentSchema,
  GatewayObservationSchema,
  GatewayOperationIdSchema,
  GatewaySourceShaSchema,
} from "../../nodes/operator/packages/gateway-activation/src/index.ts";
import { assertRuntimeSource } from "./runtime-source-admission.ts";

const CUSTODIAN = "cogni-dao/cogni";
const ROOT = "/var/lib/cogni/runtime-maintenance";
const LIB = "scripts/ci/lib";
const FILES = [
  "runtime-maintenance-guard.py",
  "runtime-recovery-receipt.py",
  "gateway-activation-host.py",
  "runtime-recovery-host.py",
  "runtime-guard-install.py",
] as const;
const hash = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const command = (file: string, args: string[], input?: string) =>
  execFileSync(file, args, {
    encoding: "utf8",
    timeout: 30000,
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const gh = (path: string) =>
  JSON.parse(
    command("gh", ["api", path, "-H", "X-GitHub-Api-Version: 2026-03-10"])
  ) as unknown;
const need = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};
const intentPath = () =>
  process.env.GITHUB_ACTIONS === "true"
    ? join(process.env.RUNNER_TEMP ?? "", "gateway-intent.json")
    : ".context/gateway-bootstrap-intent.json";

function prepare(): void {
  const op = GatewayOperationIdSchema.parse(process.env.GATEWAY_OPERATION_ID);
  const implementation = GatewaySourceShaSchema.parse(
    process.env.GATEWAY_IMPLEMENTATION_SHA
  );
  const transport = GatewaySourceShaSchema.parse(
    process.env.GATEWAY_TRANSPORT_SHA
  );
  need(
    process.env.GITHUB_REPOSITORY?.toLowerCase() === CUSTODIAN &&
      process.env.GITHUB_REF === "refs/heads/main" &&
      process.env.GITHUB_ACTOR === "cogni-operator[bot]" &&
      process.env.GITHUB_SHA === transport &&
      process.env.GITHUB_WORKFLOW_SHA === transport,
    "gateway_untrusted_workflow_transport"
  );
  const reference = z
    .object({
      object: z.object({
        type: z.literal("commit"),
        sha: GatewaySourceShaSchema,
      }),
    })
    .parse(
      gh(`repos/${CUSTODIAN}/git/ref/tags/cogni-gateway-activation/${op}`)
    );
  const commit = z
    .object({
      author: z.object({ login: z.literal("cogni-operator[bot]") }),
      commit: z.object({
        message: z.literal(`chore(gateway): persist activation ${op}`),
        verification: z.object({ verified: z.literal(true) }),
      }),
    })
    .parse(gh(`repos/${CUSTODIAN}/commits/${reference.object.sha}`));
  need(Boolean(commit), "gateway_unsigned_intent");
  const file = z
    .object({
      type: z.literal("file"),
      encoding: z.literal("base64"),
      content: z.string().max(32768),
    })
    .parse(
      gh(
        `repos/${CUSTODIAN}/contents/.cogni/gateway-activation-intent.json?ref=${reference.object.sha}`
      )
    );
  const intent = GatewayIntentSchema.parse(
    JSON.parse(Buffer.from(file.content, "base64").toString("utf8"))
  );
  need(
    intent.operationId === op &&
      intent.implementationSha === implementation &&
      intent.env === process.env.GATEWAY_ENVIRONMENT &&
      `${intent.custodian.owner}/${intent.custodian.repo}`.toLowerCase() ===
        CUSTODIAN,
    "gateway_intent_input_conflict"
  );
  assertRuntimeSource(implementation);
  writeFileSync(intentPath(), JSON.stringify(intent), { mode: 0o600 });
  need(process.env.GITHUB_OUTPUT, "gateway_output_missing");
  appendFileSync(
    process.env.GITHUB_OUTPUT ?? "",
    `implementation_sha=${implementation}\n`
  );
}

/** Native discovery is bounded and complete; missing permissions never means idle. */
function inventory(bootstrap = false): string {
  const policy = z
    .object({
      version: z.literal(1),
      writers: z.array(z.string()),
      testParent: z.literal("cogni-test-org/cogni-monorepo"),
    })
    .parse(
      JSON.parse(readFileSync(".cogni/runtime-maintenance.v1.json", "utf8"))
    );
  const all: unknown[] = [];
  const own = Number(process.env.GITHUB_RUN_ID ?? 0);
  for (const repo of [CUSTODIAN, policy.testParent]) {
    if (repo === policy.testParent || bootstrap) {
      const workflows = z
        .object({
          total_count: z.number(),
          workflows: z.array(z.object({ path: z.string(), state: z.string() })),
        })
        .parse(gh(`repos/${repo}/actions/workflows?per_page=100`));
      need(
        workflows.total_count === workflows.workflows.length &&
          workflows.total_count <= 100,
        "gateway_workflow_inventory_incomplete"
      );
      const fenced =
        repo === policy.testParent
          ? policy.writers
          : [
              "candidate-flight.yml",
              "candidate-flight-infra.yml",
              "provision-env.yml",
            ];
      for (const name of fenced) {
        const row = workflows.workflows.find(
          (w) => w.path === `.github/workflows/${name}`
        );
        need(
          row &&
            ["disabled_manually", "disabled_inactivity"].includes(row.state),
          "gateway_test_parent_writer_enabled"
        );
      }
      all.push(workflows);
    }
    for (const status of [
      "queued",
      "in_progress",
      "waiting",
      "pending",
      "requested",
    ]) {
      let seen = 0,
        total: number | undefined;
      for (let page = 1; page <= 10; page++) {
        const result = z
          .object({
            total_count: z.number().int().nonnegative(),
            workflow_runs: z
              .array(
                z.object({
                  id: z.number().int(),
                  path: z.string(),
                  head_sha: GatewaySourceShaSchema,
                })
              )
              .max(100),
          })
          .parse(
            gh(
              `repos/${repo}/actions/runs?status=${status}&per_page=100&page=${page}`
            )
          );
        need(
          result.total_count <= 1000 &&
            (total === undefined || total === result.total_count),
          "gateway_run_inventory_incomplete"
        );
        total = result.total_count;
        for (const run of result.workflow_runs) {
          if (repo === CUSTODIAN && run.id === own) continue;
          need(
            !policy.writers.some((w) => run.path === `.github/workflows/${w}`),
            "gateway_runtime_writer_active"
          );
        }
        all.push({ repo, status, ...result });
        seen += result.workflow_runs.length;
        if (seen === total) break;
        need(
          page < 10 && result.workflow_runs.length === 100,
          "gateway_run_inventory_incomplete"
        );
      }
    }
  }
  return hash(JSON.stringify(all));
}

function sshArgs(): string[] {
  const host = process.env.VM_HOST ?? "";
  need(
    /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(host),
    "gateway_vm_host_invalid"
  );
  const key =
    process.env.GITHUB_ACTIONS !== "true" &&
    process.argv[2] === "bootstrap-candidate"
      ? process.env.GATEWAY_CANDIDATE_SSH_KEY
      : join(homedir(), ".ssh/deploy_key");
  need(key, "gateway_ssh_identity_missing");
  return [
    "-i",
    key ?? "",
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=6",
  ];
}

function enroll(
  intent: GatewayIntent,
  bootstrap: boolean,
  enable: boolean
): void {
  const source = command("git", ["rev-parse", "HEAD"]);
  need(source === intent.implementationSha, "gateway_checkout_source_mismatch");
  const protectedPaths = [
    ...FILES.map((f) => `${LIB}/${f}`),
    `${LIB}/gateway-install-host.py`,
    "scripts/ci/gateway-activation.ts",
    "nodes/operator/packages/gateway-activation/src/index.ts",
  ];
  command("git", ["diff", "--exit-code", source, "--", ...protectedPaths]);
  for (const path of protectedPaths) {
    need(
      hash(command("git", ["show", `${source}:${path}`])) ===
        hash(readFileSync(path, "utf8").trimEnd()),
      "gateway_checkout_bytes_changed"
    );
  }
  const minimumSourceSha = bootstrap ? source : assertRuntimeSource(source);
  const inventorySha256 = inventory(bootstrap);
  const blobs = Object.fromEntries(
    FILES.map((f) => [f, hash(readFileSync(`${LIB}/${f}`))])
  );
  const manifest = {
    protocolVersion: 1,
    maintenanceEnabled: enable,
    env: intent.env,
    custodian: intent.custodian,
    operationId: intent.operationId,
    implementationSha: source,
    minimumSourceSha,
    coreSha256: hash(
      readFileSync("nodes/operator/packages/gateway-activation/src/index.ts")
    ),
    runnerSha256: hash(readFileSync("scripts/ci/gateway-activation.ts")),
    blobs,
    inventorySha256,
  };
  const host = `root@${process.env.VM_HOST}`;
  const stage = `${ROOT}/staging/${randomUUID()}`;
  command("ssh", [
    ...sshArgs(),
    host,
    `umask 077; install -d -m 700 ${ROOT}/staging ${stage}`,
  ]);
  try {
    command("scp", [
      ...sshArgs(),
      ...FILES.map((f) => `${LIB}/${f}`),
      `${LIB}/gateway-install-host.py`,
      `${host}:${stage}/`,
    ]);
    // Recheck after upload: staging itself cannot change installed inputs.
    inventory(bootstrap);
    command(
      "ssh",
      [...sshArgs(), host, `python3 ${stage}/gateway-install-host.py install`],
      JSON.stringify(manifest)
    );
  } finally {
    command("ssh", [...sshArgs(), host, `rm -rf -- ${stage}`]);
  }
}

async function run(bootstrap: boolean): Promise<void> {
  const drill = process.argv[3];
  need(
    drill === undefined ||
      (bootstrap &&
        [
          "--guard-only",
          "--interrupt-after-render",
          "--prove-rollback",
        ].includes(drill)),
    "gateway_command_invalid"
  );
  const intent: GatewayIntent = GatewayIntentSchema.parse(
    JSON.parse(readFileSync(intentPath(), "utf8"))
  );
  need(
    !bootstrap ||
      (process.env.GITHUB_ACTIONS !== "true" && intent.env === "candidate-a"),
    "gateway_bootstrap_candidate_only"
  );
  const transportSha = bootstrap
    ? intent.implementationSha
    : GatewaySourceShaSchema.parse(process.env.GATEWAY_TRANSPORT_SHA);
  if (!bootstrap)
    need(
      process.env.GITHUB_SHA === transportSha &&
        process.env.GITHUB_WORKFLOW_SHA === transportSha,
      "gateway_untrusted_workflow_transport"
    );
  enroll(intent, bootstrap, drill !== "--guard-only");
  if (drill === "--guard-only") {
    console.log(
      JSON.stringify({
        state: "guard_only_qualified",
        operationId: intent.operationId,
        gatewayMaintenanceEnabled: false,
        runtimeEffects: false,
      })
    );
    return;
  }
  const child = spawn(
    "ssh",
    [
      ...sshArgs(),
      `root@${process.env.VM_HOST}`,
      `python3 ${ROOT}/lib/gateway-activation-host.py serve`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 65536) child.kill();
  });
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const host: GatewayHostPort = {
    async step(action) {
      child.stdin.write(`${JSON.stringify({ action, intent })}\n`);
      const timer = setTimeout(() => child.kill(), 240000);
      try {
        const line = await iterator.next();
        need(
          !line.done && line.value.length <= 65536,
          "gateway_host_response_incomplete"
        );
        const observation = GatewayObservationSchema.parse(
          JSON.parse(line.value ?? "")
        );
        if (
          drill === "--interrupt-after-render" &&
          action === "install_render" &&
          observation.phase === "render_installed"
        ) {
          child.kill();
          throw new Error("gateway_qualification_transport_interrupted");
        }
        if (
          drill === "--prove-rollback" &&
          action === "activate" &&
          observation.phase === "gateway_verified"
        ) {
          // Candidate qualification injects only a failed observation. The same
          // state machine and real host adapter then restore the prior binding.
          return { ...observation, failure: "gateway_unhealthy" };
        }
        return observation;
      } finally {
        clearTimeout(timer);
      }
    },
  };
  try {
    const observation = await activateGateway(intent, host);
    child.stdin.end();
    const exit = await finished;
    need(exit === 0, "gateway_host_incomplete");
    const receipt = {
      version: 1,
      intent,
      transportSha,
      runId: Number(process.env.GITHUB_RUN_ID ?? 1),
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
      observation,
    };
    writeFileSync(
      join(process.env.RUNNER_TEMP ?? ".context", "gateway-receipt.json"),
      JSON.stringify(receipt),
      { mode: 0o600 }
    );
    console.log(JSON.stringify(observation));
    need(
      observation.phase === "activated" &&
        observation.currentQualified !== false,
      "gateway_activation_not_qualified"
    );
  } finally {
    child.stdin.end();
    lines.close();
    if (child.exitCode === null) child.kill();
  }
}

try {
  if (process.argv[2] === "prepare") prepare();
  else if (process.argv[2] === "run") await run(false);
  else if (process.argv[2] === "bootstrap-candidate") await run(true);
  else throw new Error("gateway_command_invalid");
} catch (error) {
  // All native tool stderr is private; never echo resolved environments.
  console.error(
    error instanceof Error && /^gateway_[a-z_]+$/.test(error.message)
      ? error.message
      : "gateway_runner_incomplete"
  );
  process.exitCode = 1;
}
