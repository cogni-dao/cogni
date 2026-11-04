// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";

import { OFF_CLUSTER_WORKLOAD_DENIED_KEYS } from "@/shared/secrets/node-secrets-reserved.data";

import { resolveEnvLanes } from "./env-lanes";

import {
  injectableSecrets,
  nodeAppEnv,
  nodeAppSecretKeys,
} from "./node-app-env";

const SHA = "a".repeat(40);
const NODE_ID = "4b06359a-0000-4000-8000-000000000001";

/** Placeholder bucket: one value per profile key, values are opaque test strings. */
function profileBucket(): Record<string, string> {
  return Object.fromEntries(
    COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS.map((k) => [k, `v-${k}`])
  );
}

/**
 * THE FIXTURE. Rendered by hand from `infra/crossplane/xcomputeworkload/composition.yaml`
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
  ])("refuses invalid root %s", (root) => {
    expect(() =>
      resolveEnvLanes({ ...config, operatorDomainRoot: root })
    ).toThrow(/NODE_DEPLOY_OPERATOR_DOMAIN_ROOT/);
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
    expect(nodeAppEnv({ ...base, secrets: profileBucket() })).toEqual(
      composedProduction()
    );
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
    expect(nodeAppSecretKeys(undefined)).toEqual(PROFILE_KEYS);
  });
});
