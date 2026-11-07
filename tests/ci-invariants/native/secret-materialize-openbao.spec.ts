// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@tests/ci-invariants/native/secret-materialize-openbao`
 * Purpose: Verify normal materialization against owned OpenBao KV v2.
 * Scope: CI-owned fixture; does not exercise the deploy writer or candidate caller.
 * Invariants: KV data, ACLs and versions are native; no deployed endpoint is contacted.
 * Side-effects: IO (owned containers, network and temporary files), time, randomness, process.env
 * Links: task.5434, scripts/ci/secret-materialize.sh
 * @internal
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import Docker from "dockerode";
import {
  GenericContainer,
  Network,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");
const declaration = readFileSync(
  path.join(root, "infra/k8s/argocd/openbao/kustomization.yaml"),
  "utf8"
);
const chart = declaration.match(/version:\s*(\d+\.\d+\.\d+)/)?.[1];
const app = declaration.match(/app v(\d+\.\d+\.\d+)/)?.[1];
// Chart 0.28.2 defaults to quay.io/openbao/openbao; fail closed on declaration drift.
if (chart !== "0.28.2" || app !== "2.5.3")
  throw new Error(
    "Reinspect pinned OpenBao chart image before updating fixture"
  );
const image = `quay.io/openbao/openbao:${app}`;

if (!process.env.CI)
  console.warn(
    "OpenBao native fixture is CI-only; local skip is not runtime proof."
  );
describe.skipIf(!process.env.CI)("normal materializer OpenBao custody", () => {
  it("selects preview authority, converges, and fails closed", async ({
    signal,
  }) => {
    await new Docker({ timeout: 10_000 }).ping();
    const dir = mkdtempSync(path.join(tmpdir(), "cogni-bao-native-"));
    const token = `root-${randomUUID()}`;
    let container: StartedTestContainer | undefined;
    let network: Awaited<ReturnType<Network["start"]>> | undefined;
    const cleanup: PromiseSettledResult<unknown>[] = [];
    try {
      network = await new Network().start();
      container = await new GenericContainer(image)
        .withNetwork(network)
        .withEnvironment({
          BAO_DEV_ROOT_TOKEN_ID: token,
          BAO_DEV_LISTEN_ADDRESS: "0.0.0.0:8200",
        })
        .withCommand(["server", "-dev"])
        .withExposedPorts(8200)
        .withWaitStrategy(
          Wait.forHttp("/v1/sys/health", 8200).forStatusCode(200)
        )
        .withStartupTimeout(90_000)
        .start();
      const id = container.getId();
      expect(id).toMatch(/^[a-f0-9]{64}$/);
      const addr = `http://${container.getHost()}:${container.getMappedPort(8200)}`;
      const cli = (args: string[], input?: string) =>
        execFileSync(
          "docker",
          [
            "exec",
            "-i",
            id,
            "env",
            "BAO_ADDR=http://127.0.0.1:8200",
            `BAO_TOKEN=${token}`,
            "bao",
            ...args,
          ],
          { input, encoding: "utf8", timeout: 20_000 }
        );
      expect(JSON.parse(cli(["status", "-format=json"])).sealed).toBe(false);
      cli(["secrets", "enable", "-path=cogni", "-version=2", "kv"]);
      const policy = `path "cogni/data/preview/*" { capabilities = ["create", "read", "update", "patch"] }\npath "cogni/metadata/preview/*" { capabilities = ["read", "list"] }\npath "cogni/data/production/operator" { capabilities = ["read"] }\n`;
      cli(["policy", "write", "fixture", "-"], policy);
      cli(
        ["policy", "write", "denied", "-"],
        `${policy}\npath "cogni/data/preview/operator" { capabilities = ["deny"] }\n`
      );
      const mint = (policyName: string) =>
        JSON.parse(
          cli([
            "token",
            "create",
            "-no-default-policy",
            `-policy=${policyName}`,
            "-format=json",
          ])
        ).auth.client_token as string;
      const writer = mint("fixture");
      const denied = mint("denied");
      const api = async (method: string, route: string, body?: unknown) => {
        const response = await fetch(`${addr}/v1/${route}`, {
          method,
          signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
          headers: {
            "X-Vault-Token": token,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok)
          throw new Error(
            `owned OpenBao ${method} ${route}: ${response.status}`
          );
        return response.status === 204 ? null : response.json();
      };
      const put = (bank: string, data: object) =>
        api("POST", `cogni/data/${bank}`, { data });
      await put("preview/operator", {
        SCHEDULER_API_TOKEN: "preview-owner",
        POSTHOG_API_KEY: "preview-posthog",
      });
      await put("production/operator", {
        SCHEDULER_API_TOKEN: "production-control",
        BILLING_INGEST_TOKEN: "fixture-billing",
        GH_WEBHOOK_SECRET: "fixture-webhook",
        POSTHOG_API_KEY: "control-posthog",
        POSTHOG_HOST: "https://posthog.fixture.invalid",
        OPENROUTER_API_KEY: "fixture-openrouter",
        EVM_RPC_URL: "https://rpc.fixture.invalid",
        LITELLM_MASTER_KEY: "fixture-master",
        POSTGRES_ROOT_PASSWORD: "fixture-db-root",
      });
      await put("preview/node-template", {
        SCHEDULER_API_TOKEN: "stale-receiver",
        UNRELATED: "preserve-me",
      });
      await put("preview/unrelated-sibling", { UNRELATED: "sibling-preserve" });
      const bin = path.join(dir, "bin");
      execFileSync("mkdir", ["-p", bin]);
      const script = (name: string, body: string) =>
        writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, {
          mode: 0o700,
        });
      // The resolver must never fall back to ambient DNS for any other alias.
      script(
        "getent",
        `[[ "$#" == 2 && "$1" == ahostsv4 && "$2" == cogni-preview.vm.fixture.invalid ]] || exit 1
printf '127.0.0.1 STREAM %s\\n' "$2"`
      );
      script("dig", "exit 1");
      script(
        "python3",
        `if [[ "\${1:-}" == -c && "\${2:-}" == *socket.getaddrinfo* ]]; then exit 1; fi
exec "$FIXTURE_PYTHON" "$@"`
      );
      script(
        "ssh",
        `set -euo pipefail
while [[ "\${1:-}" == -* ]]; do case "$1" in -i|-o) shift 2;; *) exit 90;; esac; done
[[ "\${1:-}" == root@fixture ]] || exit 91
shift
cmd="$*"
case "$cmd" in
  "timeout 15 kubectl -n openbao get service openbao -o json"|"bash -s -- 'http://127.0.0.1:8200' "*|"kubectl exec "*) PATH="$FIXTURE_BIN:$PATH" bash -c "$cmd";;
  "set -euo pipefail"*) [[ "$cmd" == *'cogni-litellm-key.'* ]] || exit 92; PATH="$FIXTURE_BIN:$PATH" bash -c "$cmd";;
  *) echo 'unexpected fixture SSH command' >&2; exit 93;;
esac`
      );
      script(
        "kubectl",
        `set -euo pipefail
if [[ "$*" == 'create token openbao-operator -n default' ]]; then echo owned.jwt.signature; exit; fi
if [[ "$*" == '-n openbao get service openbao -o json' ]]; then
  printf '%s\n' '{"metadata":{"name":"openbao","namespace":"openbao"},"spec":{"type":"ClusterIP","clusterIP":"127.0.0.1","selector":{"app.kubernetes.io/name":"openbao","app.kubernetes.io/instance":"openbao","component":"server"},"ports":[{"port":8200,"targetPort":8200,"protocol":"TCP"}]}}'; exit
fi
[[ "\${1:-}" == exec ]] || exit 94
shift
[[ "\${1:-}" == -i ]] && shift
[[ "$1 $2 $3 $4 $5" == '-n openbao openbao-0 -- env' ]] || exit 95
shift 5
[[ "$1" == BAO_TOKEN=* && "$2" == BAO_ADDR=http://127.0.0.1:8200 && "$3" == bao && "$4" == kv ]] || exit 96
[[ "$1" == "BAO_TOKEN=$FIXTURE_WRITER" ]] || exit 97
shift 3
case "\${1:-} \${2:-}" in 'kv get'|'kv metadata'|'kv put'|'kv patch') ;; *) exit 98;; esac
exec docker exec -i "$FIXTURE_ID" env BAO_ADDR=http://127.0.0.1:8200 "BAO_TOKEN=$FIXTURE_WRITER" bao "$@"`
      );
      // Reuse only the unrelated LiteLLM simulation from the existing shell fixture.
      const fake = readFileSync(
        path.join(root, "scripts/ci/tests/secret-materialize.test.sh"),
        "utf8"
      );
      const lite = fake
        .split('config="" body_file="" output_file="" wanted_alias=""')[1]
        ?.split("\nEOF\n")[0];
      if (!lite) throw new Error("Existing LiteLLM fixture boundary missing");
      script(
        "curl",
        `set -euo pipefail
last="\${!#}"
if [[ "$last" == http://127.0.0.1:8200/v1/auth/kubernetes/login ]]; then
 out=''; body=''; while [[ $# -gt 0 ]]; do case "$1" in --output) out="$2"; shift 2;; --data-binary) body="\${2#@}"; shift 2;; *) shift;; esac; done
 jq -e '.role == "production-writer" and .jwt == "owned.jwt.signature"' "$body" >/dev/null
 jq -n --arg t "$FIXTURE_WRITER" '{auth:{client_token:$t}}' > "$out"; printf 200; exit
fi
if [[ "$last" == http://127.0.0.1:8200/v1/cogni/data/* ]]; then
 args=("$@"); url="$FIXTURE_ADDR\${last#http://127.0.0.1:8200}"
 if [[ "\${FIXTURE_FAULT:-}" == transport && "$last" == */preview/operator ]]; then url="http://127.0.0.1:$FIXTURE_CLOSED_PORT\${last#http://127.0.0.1:8200}"; fi
 args[\${#args[@]}-1]="$url"; exec "$FIXTURE_CURL" "\${args[@]}"
fi
config="" body_file="" output_file="" wanted_alias=""${lite}`
      );
      const store = path.join(dir, "litellm-store");
      const log = path.join(dir, "litellm-log");
      writeFileSync(store, "");
      writeFileSync(log, "");
      const env = {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: dir,
        TMPDIR: dir,
        CI: "true",
        VM_HOST: "fixture",
        VM_IP: "127.0.0.1",
        DOMAIN: "fixture.invalid",
        FORK_DOMAIN_ROOT: "fixture.invalid",
        COGNI_DEPLOYMENT_SLUG: "cogni",
        SSH_OPTS: "-i fixture -o BatchMode=yes",
        SECRET_MATERIALIZE_SSH_BIN: path.join(bin, "ssh"),
        FIXTURE_BIN: bin,
        FIXTURE_ID: id,
        FIXTURE_ADDR: addr,
        FIXTURE_PYTHON: execFileSync("which", ["python3"], {
          encoding: "utf8",
        }).trim(),
        FIXTURE_CURL: execFileSync("which", ["curl"], {
          encoding: "utf8",
        }).trim(),
        FIXTURE_CLOSED_PORT: "0",
        FAKE_LITELLM_STORE: store,
        FAKE_LITELLM_LOG: log,
        FAKE_LITELLM_MASTER_KEY: "fixture-master",
        SECRETS_CONTROL_ENV: "production",
        POSTGRES_ROOT_PASSWORD: "fixture-db-root",
      };
      const run = (credential: string, fault = "") =>
        spawnSync(
          "bash",
          [
            path.join(root, "scripts/ci/secret-materialize.sh"),
            "preview",
            "node-template",
          ],
          {
            cwd: root,
            env: { ...env, FIXTURE_WRITER: credential, FIXTURE_FAULT: fault },
            encoding: "utf8",
            timeout: 180_000,
          }
        );
      const banks = [
        "preview/operator",
        "production/operator",
        "preview/unrelated-sibling",
        "preview/node-template",
        "preview/node-template-database-migration",
        "preview/node-template-database-recovery-probe",
      ];
      const snapshot = async () =>
        Object.fromEntries(
          await Promise.all(
            banks.map(async (bank) => {
              const response = await fetch(`${addr}/v1/cogni/data/${bank}`, {
                headers: { "X-Vault-Token": token },
                signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
              });
              if (response.status === 404) return [bank, null];
              if (!response.ok)
                throw new Error(`snapshot ${bank}: ${response.status}`);
              const result = await response.json();
              return [
                bank,
                {
                  version: result.data.metadata.version,
                  data: result.data.data,
                },
              ];
            })
          )
        );
      const before = await snapshot();
      const sibling = before["preview/unrelated-sibling"];
      expect(sibling).toEqual({
        version: 1,
        data: { UNRELATED: "sibling-preserve" },
      });
      const first = run(writer);
      expect(first.status, first.stderr).toBe(0);
      const converged = await snapshot();
      expect(converged["preview/node-template"]?.version).toBeGreaterThan(
        before["preview/node-template"]?.version
      );
      expect(converged["preview/node-template"]?.data.SCHEDULER_API_TOKEN).toBe(
        "preview-owner"
      );
      expect(converged["preview/node-template"]?.data.UNRELATED).toBe(
        "preserve-me"
      );
      expect(converged["preview/node-template"]?.data).toMatchObject({
        BILLING_INGEST_TOKEN: "fixture-billing",
        GH_WEBHOOK_SECRET: "fixture-webhook",
        POSTHOG_API_KEY: "control-posthog",
        POSTHOG_HOST: "https://posthog.fixture.invalid",
        OPENROUTER_API_KEY: "fixture-openrouter",
        EVM_RPC_URL: "https://rpc.fixture.invalid",
      });
      expect(converged["preview/unrelated-sibling"]).toEqual(sibling);
      expect(converged["production/operator"]).toEqual(
        before["production/operator"]
      );
      expect(converged["preview/operator"]).toEqual(before["preview/operator"]);
      expect(
        converged["preview/node-template-database-migration"]
      ).not.toBeNull();
      expect(
        converged["preview/node-template-database-recovery-probe"]
      ).not.toBeNull();
      const second = run(writer);
      expect(second.status, second.stderr).toBe(0);
      expect(await snapshot()).toEqual(converged);
      // Delete metadata only in this owned fixture to exercise the native cold put path.
      await api("DELETE", "cogni/metadata/preview/node-template");
      const cold = run(writer);
      expect(cold.status, cold.stderr).toBe(0);
      const coldState = await snapshot();
      expect(coldState["preview/unrelated-sibling"]).toEqual(sibling);
      expect(coldState["preview/node-template"]?.version).toBe(1);
      expect(coldState["preview/node-template"]?.data.SCHEDULER_API_TOKEN).toBe(
        "preview-owner"
      );
      await put("preview/operator", { POSTHOG_API_KEY: "preview-posthog" });
      const missingBefore = await snapshot();
      expect(missingBefore["preview/unrelated-sibling"]).toEqual(sibling);
      const missing = run(writer);
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain("refusing target/control fallback");
      expect(await snapshot()).toEqual(missingBefore);
      await put("preview/operator", {
        SCHEDULER_API_TOKEN: "preview-owner",
        POSTHOG_API_KEY: "preview-posthog",
      });
      const faultBefore = await snapshot();
      expect(faultBefore["preview/unrelated-sibling"]).toEqual(sibling);
      const forbidden = run(denied);
      expect(forbidden.status).not.toBe(0);
      expect(forbidden.stderr).toContain("http_status=403");
      expect(await snapshot()).toEqual(faultBefore);
      // Reserve and close an ephemeral fixture listener: the real curl request
      // reaches this owned, now-unavailable transport, never a deployed service.
      const listener = createServer();
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", resolve);
      });
      const listenerAddress = listener.address();
      if (!listenerAddress || typeof listenerAddress === "string")
        throw new Error("fixture listener has no TCP port");
      env.FIXTURE_CLOSED_PORT = String(listenerAddress.port);
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve()))
      );
      const unavailable = run(writer, "transport");
      expect(unavailable.status).not.toBe(0);
      expect(unavailable.stderr).toMatch(/native_rc=(7|75)/);
      expect(await snapshot()).toEqual(faultBefore);
    } finally {
      if (container)
        cleanup.push(...(await Promise.allSettled([container.stop()])));
      if (network)
        cleanup.push(...(await Promise.allSettled([network.stop()])));
      cleanup.push(
        ...(await Promise.allSettled([
          Promise.resolve().then(() =>
            rmSync(dir, { recursive: true, force: true })
          ),
        ]))
      );
    }
    const failures = cleanup.filter((item) => item.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((item) => item.reason),
        "owned fixture cleanup failed"
      );
  }, 900_000);
});
