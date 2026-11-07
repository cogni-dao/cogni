// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { readdirSync, readFileSync } from "node:fs";
import { COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";
import { OFF_CLUSTER_WORKLOAD_DENIED_KEYS } from "@/shared/secrets/node-secrets-reserved.data";

import {
  isSubstrateVmHost,
  MESH_SUBSTRATE_HOST,
  normalizeHost,
  rebindDsnEndpoint,
  resolveSubstrateBinding,
} from "./bindings";
import { resolveEnvLanes } from "./env-lanes";
import { deriveMeshPolicy, meshOwner } from "./mesh-policy";
import {
  injectableSecrets,
  nodeAppEnv,
  nodeAppSecretKeys,
  nodeAppSubstrateBinding,
  runtimeOwnedEnvKeys,
} from "./node-app-env";
import { SUBSTRATE_PORT_SET, SUBSTRATE_PORTS } from "./substrate-ports";

const SHA = "a".repeat(40);
const NODE_ID = "4b06359a-0000-4000-8000-000000000001";

/** Placeholder bucket: one value per profile key, values are opaque test strings. */
function profileBucket(): Record<string, string> {
  return Object.fromEntries(
    [...COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS, "DATABASE_MIGRATION_URL"].map(
      (k) => [k, `v-${k}`]
    )
  );
}

/**
 * THE FIXTURE. Rendered by hand from `infra/crossplane/xcomputeworkload/composition.yaml` at `37fbd413f1^` (deleted by task.5411)
 * (`$isApp` blocks, l.185-284) for these XR inputs:
 *   environment=production, workload.name=poly, publicHost=poly.cognidao.org, services[app].port=3200,
 *   bindHost=0.0.0.0, bundle.source.sha=SHA, runtime.substrateHost=cogni.vm.cognidao.org,
 *   no databasePoolLimits, logPush=false, profile secretRefs = COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS
 *   (LITELLM_VIRTUAL_KEY renamed to LITELLM_MASTER_KEY). Secret values are the composition's
 *   provider-http placeholders there and OpenBao values here; the KEY SET is what must match.
 */
function composedProduction(): Record<string, string> {
  return {
    HOST: "0.0.0.0",
    HOSTNAME: "0.0.0.0",
    PORT: "3200",
    APP_ENV: "production",
    DEPLOY_ENVIRONMENT: "production",
    COGNI_REPO_SHA: SHA,
    TEMPORAL_ADDRESS: "cogni.vm.cognidao.org:7233",
    TEMPORAL_NAMESPACE: "cogni-production",
    TEMPORAL_TASK_QUEUE: "scheduler-tasks",
    REDIS_URL: "redis://cogni.vm.cognidao.org:6379",
    LITELLM_BASE_URL: "http://cogni.vm.cognidao.org:4000",
    SCHEDULER_WORKER_HEALTH_URL: "http://cogni.vm.cognidao.org:30900",
    AUTH_SECRET: "v-AUTH_SECRET",
    DATABASE_URL: "v-DATABASE_URL",
    DATABASE_SERVICE_URL: "v-DATABASE_SERVICE_URL",
    DATABASE_SSL_CA_CERT: "v-DATABASE_SSL_CA_CERT",
    DOLTGRES_URL: "v-DOLTGRES_URL",
    EVM_RPC_URL: "v-EVM_RPC_URL",
    LITELLM_MASTER_KEY: "v-LITELLM_VIRTUAL_KEY",
    SCHEDULER_API_TOKEN: "v-SCHEDULER_API_TOKEN",
    BILLING_INGEST_TOKEN: "v-BILLING_INGEST_TOKEN",
    COGNI_NODE_ID: NODE_ID,
    DOMAIN: "cognidao.org",
    NODE_NAME: "poly",
    COGNI_REPO_PATH: "/app",
    AUTH_TRUST_HOST: "true",
    NEXTAUTH_URL: "https://poly.cognidao.org",
    APP_BASE_URL: "https://poly.cognidao.org",
  };
}

const base = {
  env: "production",
  slug: "poly",
  nodeId: NODE_ID,
  sourceSha: SHA,
  publicHost: "poly.cognidao.org",
  operatorDomain: "cognidao.org",
  port: 3200,
  substrateHost: "cogni.vm.cognidao.org",
} as const;

describe("operator issuer", () => {
  it("uses the platform issuer when DOMAIN is a declared bucket key", () => {
    const env = nodeAppEnv({
      ...base,
      operatorDomain: "test.operator.example",
      secretKeys: [...COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS, "DOMAIN"],
      secrets: { ...profileBucket(), DOMAIN: "attacker.example" },
    });
    expect(env.DOMAIN).toBe("test.operator.example");
  });
});

describe("operator issuer lane configuration", () => {
  const config = {
    deployEnvironment: "production",
    podNamespace: "control",
    secretsNamespace: "cogni-node-deploy-production",
    substrateHost: "substrate.internal",
    operatorDomainRoot: "operator.example",
    environments: "candidate-a,preview,production",
    substrateHosts:
      "candidate-a=candidate.internal,preview=preview.internal,production=production.internal",
  };
  it("uses workload lanes, independently of control and substrate hosts", () => {
    expect(resolveEnvLanes(config).map((lane) => lane.operatorDomain)).toEqual([
      "test.operator.example",
      "preview.operator.example",
      "operator.example",
    ]);
  });
  it.each([
    undefined,
    "",
    "https://operator.example",
    "bad..example",
    "operator.example:443",
  ])("keeps lanes observable with invalid root %s", (root) => {
    expect(
      resolveEnvLanes({ ...config, operatorDomainRoot: root }).every(
        (lane) => lane.operatorDomain === ""
      )
    ).toBe(true);
  });
  it("refuses unsupported envs in both configuration forms", () => {
    expect(() => resolveEnvLanes({ ...config, environments: "mars" })).toThrow(
      /environment/
    );
    expect(() =>
      resolveEnvLanes({
        ...config,
        environments: undefined,
        deployEnvironment: "mars",
      })
    ).toThrow(/environment/);
  });
});

describe("nodeAppEnv parity with the Crossplane composition", () => {
  it("renders the composition's env key by key for a stock node", () => {
    // One deliberate addition (task.5408): the composition migrated in a separate Job; the verb's green
    // lease migrates itself, so it also carries the isolated migration DSN (unset before the app starts).
    expect(nodeAppEnv({ ...base, secrets: profileBucket() })).toEqual({
      ...composedProduction(),
      DATABASE_MIGRATION_URL: "v-DATABASE_MIGRATION_URL",
    });
  });

  it("a non-production lane follows the lane env in DEPLOY_ENVIRONMENT and the Temporal namespace", () => {
    const env = nodeAppEnv({
      ...base,
      env: "candidate-a",
      substrateHost: "cogni-candidate-a.vm.cognidao.org",
      secrets: profileBucket(),
    });
    expect(env.DEPLOY_ENVIRONMENT).toBe("candidate-a");
    expect(env.TEMPORAL_NAMESPACE).toBe("cogni-candidate-a");
    expect(env.TEMPORAL_ADDRESS).toBe("cogni-candidate-a.vm.cognidao.org:7233");
    expect(env.APP_ENV).toBe("production");
  });

  it("an absent substrate host omits the whole substrate block (composition parity)", () => {
    const env = nodeAppEnv({
      ...base,
      substrateHost: undefined,
      secrets: profileBucket(),
    });
    for (const k of [
      "TEMPORAL_ADDRESS",
      "TEMPORAL_NAMESPACE",
      "TEMPORAL_TASK_QUEUE",
      "REDIS_URL",
      "LITELLM_BASE_URL",
      "SCHEDULER_WORKER_HEALTH_URL",
    ])
      expect(env).not.toHaveProperty(k);
  });

  it("renames LITELLM_VIRTUAL_KEY to LITELLM_MASTER_KEY and never passes it under its own name", () => {
    const env = nodeAppEnv({ ...base, secrets: profileBucket() });
    expect(env.LITELLM_MASTER_KEY).toBe("v-LITELLM_VIRTUAL_KEY");
    expect(env).not.toHaveProperty("LITELLM_VIRTUAL_KEY");
  });

  it("database pool maxes and opt-in Loki push render when supplied", () => {
    const env = nodeAppEnv({
      ...base,
      secrets: profileBucket(),
      databasePoolLimits: { app: 5, service: 2, read: 3, replicaCount: 1 },
      lokiPush: { url: "https://loki/push", user: "123", password: "tok" },
    });
    expect(env).toMatchObject({
      DB_POOL_MAX: "5",
      DB_SERVICE_POOL_MAX: "2",
      DB_READ_POOL_MAX: "3",
      LOKI_PUSH_URL: "https://loki/push",
      LOKI_PUSH_USER: "123",
      LOKI_PUSH_PASSWORD: "tok",
      LOKI_PUSH_SOURCE: "lease",
    });
  });

  it("database pools require exactly one replica", () => {
    expect(() =>
      nodeAppEnv({
        ...base,
        secrets: profileBucket(),
        databasePoolLimits: { app: 5, service: 2, read: 3, replicaCount: 2 },
      })
    ).toThrow(/exactly one app replica/);
  });

  it("the identity block wins over a bucket key of the same name", () => {
    const env = nodeAppEnv({
      ...base,
      secrets: {
        ...profileBucket(),
        NODE_NAME: "evil",
        NEXTAUTH_URL: "https://evil.example",
        APP_BASE_URL: "https://evil.example",
        AUTH_TRUST_HOST: "false",
        COGNI_REPO_PATH: "/tmp",
        COGNI_NODE_ID: "not-the-node",
      },
    });
    expect(env).toMatchObject({
      NODE_NAME: "poly",
      NEXTAUTH_URL: "https://poly.cognidao.org",
      APP_BASE_URL: "https://poly.cognidao.org",
      AUTH_TRUST_HOST: "true",
      COGNI_REPO_PATH: "/app",
      COGNI_NODE_ID: NODE_ID,
    });
  });
});

const PROFILE_KEYS = [...COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS];

describe("nodeAppEnv declared keys (DECLARED_KEYS_ONLY)", () => {
  it("a declared secret_ref beyond the profile IS injected (poly's PAPER_ENFORCE_MODE)", () => {
    const env = nodeAppEnv({
      ...base,
      secretKeys: [
        ...PROFILE_KEYS,
        "PAPER_ENFORCE_MODE",
        "POLY_WALLET_AEAD_KEY_HEX",
      ],
      secrets: {
        ...profileBucket(),
        PAPER_ENFORCE_MODE: "true",
        POLY_WALLET_AEAD_KEY_HEX: "ab",
      },
    });
    expect(env.PAPER_ENFORCE_MODE).toBe("true");
    expect(env.POLY_WALLET_AEAD_KEY_HEX).toBe("ab");
  });

  it("a fleet-inherited key that is in the bucket but NOT declared is never injected", () => {
    const inherited = {
      GH_WEBHOOK_SECRET: "wh",
      POSTHOG_API_KEY: "ph",
      TAVILY_API_KEY: "tv",
      OPENROUTER_API_KEY: "or",
      SOMETHING_ELSE: "x",
    };
    const env = nodeAppEnv({
      ...base,
      secretKeys: PROFILE_KEYS,
      secrets: { ...profileBucket(), ...inherited },
    });
    for (const k of Object.keys(inherited)) expect(env).not.toHaveProperty(k);
    // an absent secretKeys means the profile keys only: the same guarantee
    const stock = nodeAppEnv({
      ...base,
      secrets: { ...profileBucket(), ...inherited },
    });
    for (const k of Object.keys(inherited)) expect(stock).not.toHaveProperty(k);
    expect(stock.AUTH_SECRET).toBe("v-AUTH_SECRET");
  });

  it("refuses a DECLARED operator/fleet credential outright, for every denylisted key", () => {
    for (const k of OFF_CLUSTER_WORKLOAD_DENIED_KEYS)
      expect(
        () =>
          nodeAppEnv({
            ...base,
            secretKeys: [...PROFILE_KEYS, k],
            secrets: { ...profileBucket(), [k]: "leak" },
          }),
        k
      ).toThrow(/may not be injected/);
  });

  it("fails closed, naming the keys, when a declared key is missing or empty", () => {
    const bucket = profileBucket();
    delete bucket.AUTH_SECRET;
    bucket.EVM_RPC_URL = "";
    expect(() => nodeAppEnv({ ...base, secrets: bucket })).toThrow(
      /AUTH_SECRET, EVM_RPC_URL/
    );
    expect(() =>
      nodeAppEnv({
        ...base,
        secretKeys: [...PROFILE_KEYS, "PAPER_ENFORCE_MODE"],
        secrets: profileBucket(),
      })
    ).toThrow(/PAPER_ENFORCE_MODE/);
  });

  it("injectableSecrets keeps declared, well-formed, non-empty values only", () => {
    expect(
      injectableSecrets(["GOOD", "EMPTY", "bad-name", "ABSENT"], {
        GOOD: "1",
        EMPTY: "",
        "bad-name": "x",
        UNDECLARED: "y",
      })
    ).toEqual({ GOOD: "1" });
  });

  it("a key supplied by a declared state binding is not required from the bucket (CD2)", () => {
    const bucket = profileBucket();
    delete bucket.DATABASE_URL;
    expect(() => nodeAppEnv({ ...base, secrets: bucket })).toThrow(
      /DATABASE_URL/
    );
    const env = nodeAppEnv({
      ...base,
      secrets: bucket,
      boundEnvNames: ["DATABASE_URL"],
    });
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(nodeAppSecretKeys(undefined, ["DATABASE_URL"])).not.toContain(
      "DATABASE_URL"
    );
    expect(nodeAppSecretKeys(undefined)).toEqual([
      ...PROFILE_KEYS,
      "DATABASE_MIGRATION_URL",
    ]);
  });

  it("every node app gets its migration DSN, except one whose DATABASE_URL a state binding supplies (task.5408)", () => {
    expect(nodeAppSecretKeys(["AUTH_SECRET"])).toEqual([
      "AUTH_SECRET",
      "DATABASE_MIGRATION_URL",
    ]);
    expect(
      nodeAppSecretKeys(["AUTH_SECRET", "DATABASE_MIGRATION_URL"])
    ).toEqual(["AUTH_SECRET", "DATABASE_MIGRATION_URL"]);
    expect(nodeAppSecretKeys(undefined, ["DATABASE_URL"])).not.toContain(
      "DATABASE_MIGRATION_URL"
    );
  });
});

/**
 * task.5432 (design: node-service-delivery, connectivity decision). A mesh attempt binds the shared
 * services through the `cogni-substrate` companion. Hard requirements: 1 (no VM host in the env), 3 (no
 * injected port without a grant), 13 (no mesh identifier), 14 (no secret in the binding).
 */
describe("mesh transport (task.5432)", () => {
  const VM_HOST = "cogni-candidate-a.vm.cognidao.org";
  const VM_IP = "203.0.113.7";
  const CELL = "poly-cell.provider.example";
  const DOLTGRES_BUCKET = `postgresql://postgres:s3cr%2Ft@${VM_IP}:5435/knowledge_poly?sslmode=disable`;
  const pg = (host: string, role: string) =>
    `postgresql://${role}:pw%21@${host}:5432/cogni_poly?sslmode=disable`;
  const postgresOn = (host: string): Record<string, string> => ({
    DATABASE_URL: pg(host, "app_poly"),
    DATABASE_SERVICE_URL: pg(host, "service_poly"),
    DATABASE_MIGRATION_URL: pg(host, "migration_poly"),
  });
  const lane = {
    ...base,
    env: "candidate-a",
    substrateHost: VM_HOST,
    substrateAddresses: [VM_IP],
  } as const;
  /** Doltgres on the VM (by address, as the materializer writes it); Postgres on a dedicated cell. */
  const bucket = (): Record<string, string> => ({
    ...profileBucket(),
    DOLTGRES_URL: DOLTGRES_BUCKET,
    ...postgresOn(CELL),
  });
  const egress = () => nodeAppEnv({ ...lane, secrets: bucket() });
  const meshInput = (secrets: Record<string, string> = bucket()) => ({
    ...lane,
    transport: "mesh" as const,
    secrets,
  });
  const mesh = (secrets?: Record<string, string>) =>
    nodeAppEnv(meshInput(secrets));

  it("an absent transport is egress, byte for byte", () => {
    expect(
      nodeAppEnv({ ...lane, transport: "egress", secrets: bucket() })
    ).toEqual(egress());
    expect(egress().DOLTGRES_URL).toBe(DOLTGRES_BUCKET);
    expect(egress().DATABASE_URL).toBe(pg(CELL, "app_poly"));
    expect(egress().SCHEDULER_WORKER_HEALTH_URL).toBe(
      `http://${VM_HOST}:30900`
    );
  });

  it("names cogni-substrate with registry ports, including the deep-health URL (review B1)", () => {
    expect(mesh()).toMatchObject({
      TEMPORAL_ADDRESS: "cogni-substrate:7233",
      TEMPORAL_NAMESPACE: "cogni-candidate-a",
      TEMPORAL_TASK_QUEUE: "scheduler-tasks",
      REDIS_URL: "redis://cogni-substrate:6379",
      LITELLM_BASE_URL: "http://cogni-substrate:4000",
      SCHEDULER_WORKER_HEALTH_URL: "http://cogni-substrate:30900",
    });
  });

  it("B1: the deep-health port is a registry row, in the mesh grant, and the mesh policy grants it", () => {
    expect(SUBSTRATE_PORTS["scheduler-worker-health"]).toBe(30900);
    expect(SUBSTRATE_PORT_SET.has(30900)).toBe(true);
    const binding = nodeAppSubstrateBinding(meshInput());
    expect(binding?.types).toContain("scheduler-worker-health");
    expect(binding?.ports).toContain(30900);
    const policy = deriveMeshPolicy({
      owner: meshOwner("candidate-a"),
      grants: [{ nodeId: NODE_ID, ports: binding?.ports ?? [] }],
    });
    expect(policy.acls[0]?.dst[0]).toContain("30900");
  });

  it("rebuilds DOLTGRES_URL from the binding and keeps only the bucket credential, database and query", () => {
    expect(mesh().DOLTGRES_URL).toBe(
      "postgresql://postgres:s3cr%2Ft@cogni-substrate:5435/knowledge_poly?sslmode=disable"
    );
  });

  it("HR1: the mesh env names no VM host or VM address", () => {
    const values = Object.values(mesh()).join("\n");
    expect(values).not.toContain(VM_HOST);
    expect(values).not.toContain(VM_IP);
    expect(values).not.toMatch(/\.vm\./);
  });

  it("HR3: every port the mesh env injects is in the attempt's grant, and the grant is registry-only", () => {
    const binding = nodeAppSubstrateBinding(meshInput());
    expect(binding).toEqual({
      transport: "mesh",
      host: MESH_SUBSTRATE_HOST,
      types: [
        "doltgres",
        "redis",
        "ai-gateway",
        "temporal",
        "scheduler-worker-health",
      ],
      ports: [4000, 5435, 6379, 7233, 30900],
    });
    for (const p of binding?.ports ?? [])
      expect(SUBSTRATE_PORT_SET.has(p)).toBe(true);
    const injected = Object.values(mesh()).flatMap((v) =>
      [...v.matchAll(/cogni-substrate:(\d+)/g)].map((m) => Number(m[1]))
    );
    expect(new Set(injected)).toEqual(new Set(binding?.ports));
  });

  it("HR13/HR14: the mesh env has exactly the egress key set, so no mesh id or credential reaches the app", () => {
    expect(Object.keys(mesh()).sort()).toEqual(Object.keys(egress()).sort());
    expect(Object.values(mesh()).join("\n")).not.toMatch(/tag:|tskey|mesh-/i);
    expect(runtimeOwnedEnvKeys("app", [])).toContain(
      "SCHEDULER_WORKER_HEALTH_URL"
    );
  });

  it("HR14: the binding the sequencer hands the mesh grant holds no secret value", () => {
    const text = JSON.stringify(
      nodeAppSubstrateBinding(meshInput(withVmPostgres()))
    );
    for (const v of Object.values(withVmPostgres()))
      expect(text).not.toContain(v);
    expect(text).not.toContain("s3cr");
    expect(text).not.toContain("pw%21");
  });

  function withVmPostgres(host = VM_IP): Record<string, string> {
    return { ...bucket(), ...postgresOn(host) };
  }

  describe("DOLTGRES_ON_THE_VM (review B2)", () => {
    it("rebinds a Doltgres DSN that names the lane host name", () => {
      const env = mesh({
        ...bucket(),
        DOLTGRES_URL: `postgresql://postgres:x@${VM_HOST}:5435/knowledge_poly`,
      });
      expect(env.DOLTGRES_URL).toBe(
        "postgresql://postgres:x@cogni-substrate:5435/knowledge_poly"
      );
    });

    it("refuses a Doltgres DSN on another host before the paid create, in both the grant and the env", () => {
      const secrets = {
        ...bucket(),
        DOLTGRES_URL:
          "postgresql://postgres:x@doltgres.elsewhere.example:5435/knowledge_poly",
      };
      expect(() => mesh(secrets)).toThrow(/DOLTGRES_URL is not on the lane VM/);
      expect(() => nodeAppSubstrateBinding(meshInput(secrets))).toThrow(
        /DOLTGRES_URL is not on the lane VM/
      );
    });

    it("refuses a VM-address Doltgres DSN when no addresses are supplied (fail safe, nothing paid)", () => {
      for (const substrateAddresses of [undefined, []])
        expect(() =>
          nodeAppEnv({ ...meshInput(), substrateAddresses })
        ).toThrow(/DOLTGRES_URL is not on the lane VM/);
    });

    it("refuses an unparseable or endpoint-overriding Doltgres DSN and never echoes its value", () => {
      for (const bad of [
        "v-DOLTGRES_URL",
        "mysql://u:p@h:3306/db",
        `postgresql://${VM_IP}:5435/knowledge_poly`,
        `postgresql://u:p@${VM_IP}:5435`,
        `postgresql://u:p@${VM_IP},other:5435/knowledge_poly`,
        `postgresql://u:secretpw@${VM_IP}:5435/knowledge_poly?host=10.0.0.9`,
      ]) {
        let message = "";
        try {
          mesh({ ...bucket(), DOLTGRES_URL: bad });
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message, bad).toMatch(/^node app env refused: DOLTGRES_URL: /);
        expect(message).not.toContain("secretpw");
      }
    });

    it("a DOLTGRES_URL supplied by a state binding is neither required nor rebound, and leaves the grant", () => {
      const b = bucket();
      delete b.DOLTGRES_URL;
      const input = { ...meshInput(b), boundEnvNames: ["DOLTGRES_URL"] };
      expect(nodeAppEnv(input)).not.toHaveProperty("DOLTGRES_URL");
      expect(nodeAppSubstrateBinding(input)?.ports).toEqual([
        4000, 6379, 7233, 30900,
      ]);
    });
  });

  describe("SHARED_POSTGRES_ONLY", () => {
    it("a dedicated-cell Postgres DSN is untouched and Postgres is not granted", () => {
      const env = mesh();
      expect(env.DATABASE_URL).toBe(pg(CELL, "app_poly"));
      expect(env.DATABASE_SERVICE_URL).toBe(pg(CELL, "service_poly"));
      expect(env.DATABASE_MIGRATION_URL).toBe(pg(CELL, "migration_poly"));
      const binding = nodeAppSubstrateBinding(meshInput());
      expect(binding?.types).not.toContain("postgres");
      expect(binding?.ports).not.toContain(5432);
    });

    it("shared-VM Postgres DSNs (by name, any case) rebind to cogni-substrate and the grant gains Postgres", () => {
      const secrets = withVmPostgres(VM_HOST.toUpperCase());
      const env = mesh(secrets);
      for (const [key, role] of [
        ["DATABASE_URL", "app_poly"],
        ["DATABASE_SERVICE_URL", "service_poly"],
        ["DATABASE_MIGRATION_URL", "migration_poly"],
      ] as const)
        expect(env[key]).toBe(pg("cogni-substrate", role));
      expect(Object.values(env).join("\n")).not.toContain(VM_HOST);
      expect(nodeAppSubstrateBinding(meshInput(secrets))?.ports).toEqual([
        4000, 5432, 5435, 6379, 7233, 30900,
      ]);
    });

    it("a DSN naming one of the lane host's resolved addresses rebinds and grants Postgres", () => {
      const input = {
        ...meshInput(withVmPostgres(VM_IP)),
        substrateAddresses: ["198.51.100.9", VM_IP],
      };
      const env = nodeAppEnv(input);
      expect(env.DATABASE_URL).toBe(pg("cogni-substrate", "app_poly"));
      expect(Object.values(env).join("\n")).not.toContain(VM_IP);
      expect(nodeAppSubstrateBinding(input)?.ports).toContain(5432);
    });

    it("IPv6 addresses compare in normalized form", () => {
      const v6 = "[2001:DB8:0:0::7]";
      const input = {
        ...meshInput({
          ...withVmPostgres(v6),
          DOLTGRES_URL: `postgresql://postgres:x@${v6}:5435/knowledge_poly`,
        }),
        substrateAddresses: ["2001:db8::7"],
      };
      expect(nodeAppEnv(input).DATABASE_URL).toBe(
        pg("cogni-substrate", "app_poly")
      );
      expect(nodeAppSubstrateBinding(input)?.ports).toContain(5432);
      expect(normalizeHost("[2001:0db8:0000::0007]")).toBe("2001:db8::7");
      expect(normalizeHost("010.0.0.1")).toBeUndefined();
      expect(normalizeHost("not:an:ip:::x")).toBeUndefined();
    });

    it("no addresses: a VM-address Postgres DSN is not rebound (the Doltgres refusal then stops the attempt)", () => {
      const input = {
        ...meshInput({
          ...withVmPostgres(VM_IP),
          DOLTGRES_URL: `postgresql://postgres:x@${VM_HOST}:5435/knowledge_poly`,
        }),
        substrateAddresses: [],
      };
      expect(nodeAppEnv(input).DATABASE_URL).toBe(pg(VM_IP, "app_poly"));
      expect(nodeAppSubstrateBinding(input)?.ports).not.toContain(5432);
    });

    it("a host matching neither the name nor an address is never rebound", () => {
      expect(isSubstrateVmHost(CELL, VM_HOST, [VM_IP, "2001:db8::7"])).toBe(
        false
      );
      expect(isSubstrateVmHost("203.0.113.70", VM_HOST, [VM_IP])).toBe(false);
    });

    it("refuses a partial split: some Postgres DSNs on the VM, some not (node-database-contract)", () => {
      const secrets = {
        ...bucket(),
        DATABASE_MIGRATION_URL: pg(VM_IP, "migration_poly"),
      };
      expect(() => mesh(secrets)).toThrow(
        /Postgres DSNs disagree on the endpoint: DATABASE_MIGRATION_URL on the lane VM, DATABASE_URL, DATABASE_SERVICE_URL elsewhere/
      );
      expect(() => nodeAppSubstrateBinding(meshInput(secrets))).toThrow(
        /disagree/
      );
    });

    it("refuses an unparseable or endpoint-overriding Postgres DSN, like Doltgres", () => {
      for (const bad of [
        "v-DATABASE_URL",
        `postgresql://app_poly:pw@${CELL}:5432/cogni_poly?sslmode=require&hostaddr=10.0.0.9`,
        `postgresql://app_poly:pw@${CELL}:5432/cogni_poly?PORT=6543`,
      ])
        expect(() => mesh({ ...bucket(), DATABASE_URL: bad }), bad).toThrow(
          /^node app env refused: DATABASE_URL: /
        );
    });

    it("egress leaves every DSN untouched and never refuses", () => {
      const env = nodeAppEnv({
        ...lane,
        secrets: { ...withVmPostgres(VM_IP), DOLTGRES_URL: "v-DOLTGRES_URL" },
      });
      expect(env.DATABASE_URL).toBe(pg(VM_IP, "app_poly"));
      expect(env.DOLTGRES_URL).toBe("v-DOLTGRES_URL");
    });
  });
});

describe("substrate binding primitives (task.5432)", () => {
  it("egress with no VM host is no binding (composition parity); mesh always binds", () => {
    expect(
      resolveSubstrateBinding({ transport: "egress", types: ["redis"] })
    ).toBeUndefined();
    expect(
      resolveSubstrateBinding({
        transport: "egress",
        vmHost: "vm.example",
        types: ["redis", "temporal", "redis"],
      })
    ).toEqual({
      transport: "egress",
      host: "vm.example",
      types: ["redis", "temporal"],
      ports: [6379, 7233],
    });
  });

  it("refuses a type that is not a registry row and an unknown transport", () => {
    expect(() =>
      resolveSubstrateBinding({
        transport: "mesh",
        types: ["ssh" as never],
      })
    ).toThrow(/not a registry type/);
    expect(() =>
      resolveSubstrateBinding({ transport: "wireguard" as never, types: [] })
    ).toThrow(/unknown transport/);
  });

  it("rebindDsnEndpoint replaces only host and port, and refuses endpoint overrides and multi-host", () => {
    expect(
      rebindDsnEndpoint(
        "postgres://app_x:p%40ss@[2001:db8::1]:5432/cogni_x?sslmode=disable&a=b",
        "cogni-substrate",
        SUBSTRATE_PORTS.doltgres
      )
    ).toBe(
      "postgres://app_x:p%40ss@cogni-substrate:5435/cogni_x?sslmode=disable&a=b"
    );
    expect(
      rebindDsnEndpoint(
        "postgresql://u:p@vm/knowledge",
        "cogni-substrate",
        5435
      )
    ).toBe("postgresql://u:p@cogni-substrate:5435/knowledge");
    expect(() =>
      rebindDsnEndpoint("postgresql://u:p@vm/db?host=x", "h", 5435)
    ).toThrow(/overrides the endpoint/);
    expect(() =>
      rebindDsnEndpoint("postgresql://u:p@a,b/db", "h", 5435)
    ).toThrow(/single-host/);
    expect(() =>
      rebindDsnEndpoint("postgresql://u:p@vm/db", "a b", 5435)
    ).toThrow(/plain name/);
    expect(() =>
      rebindDsnEndpoint("postgresql://u:p@vm/db", "h", 70000)
    ).toThrow(/out of range/);
  });
});

/** Strip block and line comments; `https://` inside strings survives (`//` preceded by `:`). */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const codeOf = (file: string): string =>
  stripComments(readFileSync(new URL(file, import.meta.url), "utf8"));

describe("CD2 one port table (task.5431 temporary exit, closed by task.5432)", () => {
  it("node-app-env.ts holds no port literal: every port comes from substrate-ports.ts", () => {
    const code = codeOf("./node-app-env.ts");
    expect(code).not.toMatch(/(?<![\w.])\d{4,5}(?![\w])/);
    expect(code).not.toMatch(/:\d{2,5}\b/);
  });

  it("no node-deploy source outside substrate-ports.ts spells a substrate port", () => {
    const dir = new URL(".", import.meta.url);
    const sources = readdirSync(dir).filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.endsWith(".test.ts") &&
        f !== "substrate-ports.ts"
    );
    expect(sources).toContain("node-app-env.ts");
    for (const file of sources) {
      const code = codeOf(`./${file}`);
      for (const p of Object.values(SUBSTRATE_PORTS)) {
        // `host:<port>` in a string, or a bare numeric literal (not part of a UUID or a longer token).
        expect(code, `${file} spells ${p}`).not.toMatch(
          new RegExp(`:${p}(?!\\d)|(?<![\\w.\\-])${p}(?![\\w.\\-])`)
        );
      }
    }
  });
});
