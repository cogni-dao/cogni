// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";

import { OFF_CLUSTER_WORKLOAD_DENIED_KEYS } from "@/shared/secrets/node-secrets-reserved.data";

import {
  injectableSecrets,
  nodeAppEnv,
  nodeAppRequiredSecretKeys,
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
  port: 3200,
  substrateHost: "cogni.vm.cognidao.org",
} as const;

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

describe("nodeAppEnv bucket policy (EVERY_BUCKET_KEY_EXCEPT_THE_DENYLIST)", () => {
  it("injects node-owned keys beyond the profile (a node's own secret_refs)", () => {
    const env = nodeAppEnv({
      ...base,
      secrets: {
        ...profileBucket(),
        PAPER_ENFORCE_MODE: "true",
        POLY_WALLET_AEAD_KEY_HEX: "ab",
      },
    });
    expect(env.PAPER_ENFORCE_MODE).toBe("true");
    expect(env.POLY_WALLET_AEAD_KEY_HEX).toBe("ab");
  });

  it("drops every denylisted operator/fleet/substrate key even when it is in the bucket", () => {
    const poisoned = Object.fromEntries(
      [...OFF_CLUSTER_WORKLOAD_DENIED_KEYS].map((k) => [k, "leak"])
    );
    const env = nodeAppEnv({
      ...base,
      secrets: { ...profileBucket(), ...poisoned },
    });
    for (const k of OFF_CLUSTER_WORKLOAD_DENIED_KEYS)
      if (k !== "LITELLM_MASTER_KEY") expect(env).not.toHaveProperty(k);
    // The fleet master key can never arrive through the bucket ("leak" is dropped): the only
    // LITELLM_MASTER_KEY in the env is the node's renamed virtual key.
    expect(env.LITELLM_MASTER_KEY).toBe("v-LITELLM_VIRTUAL_KEY");
  });

  it("drops malformed names and empty values", () => {
    const out = injectableSecrets({
      GOOD: "1",
      "bad-name": "x",
      lower: "x",
      EMPTY: "",
    });
    expect(out).toEqual({ GOOD: "1" });
  });

  it("fails closed, naming the keys, when a profile key is missing or empty", () => {
    const bucket = profileBucket();
    delete bucket.AUTH_SECRET;
    bucket.EVM_RPC_URL = "";
    expect(() => nodeAppEnv({ ...base, secrets: bucket })).toThrow(
      /AUTH_SECRET, EVM_RPC_URL/
    );
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
    expect(nodeAppRequiredSecretKeys(["DATABASE_URL"])).not.toContain(
      "DATABASE_URL"
    );
  });
});
