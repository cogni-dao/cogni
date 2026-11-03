// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/redis-acl-phase-a`
 * Purpose: Pin the additive shape of task.5384 phase A on the shared runtime Redis.
 * Scope: Production Compose declaration, secrets catalog and the shared ACL lib (static reads); does not start Redis or reach any VM.
 * Invariants:
 *   - ACL_FILE_PERSISTS_ONLY_USERS: Redis loads an ACL file from a named volume while
 *     `--save ''` keeps the stream plane ephemeral.
 *   - DEFAULT_USER_STAYS_OPEN: the seeded `default` user is `on nopass` with full access,
 *     so every consumer that has not switched keeps working (phase B turns it off).
 *   - CATALOG_OWNS_THE_PASSWORD: REDIS_PASSWORD is a per-node, agent-generated,
 *     compose-consumed catalog entry (never a pod key, never a human value).
 *   - HASH_ONLY_CROSSES_SSH: the shared lib installs users by `#<sha256>` only.
 * Side-effects: IO (reads repository files).
 * Links: task.5384, docs/spec/cicd-platform-boundary.md
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const root = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const compose = yaml.parse(
  read("infra/compose/runtime/docker-compose.yml")
) as {
  services: Record<
    string,
    {
      command?: string[];
      volumes?: string[];
      healthcheck?: { test?: string[] };
    }
  >;
  volumes: Record<string, { name?: string }>;
};
const catalog = yaml.parse(read("infra/secrets-catalog.yaml")) as {
  secrets: Array<Record<string, unknown>>;
};

describe("task.5384 phase A — per-consumer Redis ACL users, default still open", () => {
  const redis = compose.services.redis;
  const script = (redis.command ?? []).join(" ");

  it("loads the ACL file from a named volume and persists nothing else", () => {
    expect(redis.volumes).toContain("redis_acl:/data");
    expect(compose.volumes.redis_acl?.name).toBe("redis_acl");
    expect(script).toContain("--aclfile /data/users.acl");
    expect(script).toContain("--save ''");
    expect(script).not.toMatch(/--appendonly\s+yes/);
    // The entrypoint still drops privileges to the redis user.
    expect(script).toContain("exec docker-entrypoint.sh redis-server");
  });

  it("seeds the default user open, exactly as Redis' built-in default", () => {
    expect(script).toContain(
      "[ -s /data/users.acl ] || echo 'user default on nopass ~* &* +@all' > /data/users.acl"
    );
    // The unauthenticated healthcheck still relies on the open default user.
    expect(redis.healthcheck?.test).toEqual(["CMD", "redis-cli", "ping"]);
  });

  it("declares REDIS_PASSWORD as a per-node agent secret consumed by the substrate", () => {
    const entry = catalog.secrets.find((s) => s.name === "REDIS_PASSWORD");
    expect(entry).toMatchObject({
      tier: "A1",
      source: "agent",
      consumedBy: ["compose"],
      generate: { kind: "hex", bytes: 32 },
    });
    expect(entry?.service).toBeUndefined();
    expect(entry?.shared).toBeUndefined();
  });

  it("installs users by hash, never touching the default user", () => {
    const lib = read("scripts/ci/lib/redis-acl.sh");
    expect(lib).toContain("ACL SETUSER '${user}' reset on '#${hash}'");
    expect(lib).toContain("ACL SAVE");
    // Least privilege: run:* plus the node's own node:<nodeId>:* keys, stream commands only.
    expect(lib).toContain(
      "resetchannels '~run:*' '~node:%s:*' -@all +@connection -@admin -@dangerous +info +xadd +xread +xrange +xlen +expire"
    );
    // Remote scripts fail loud: a docker/redis-cli failure is never a skip.
    expect(lib).toContain("set -euo pipefail");
    for (const refused of ["FLUSHALL", "KEYS", "SCAN", "EVAL"]) {
      expect(lib).toContain(`refused ${refused}`);
    }
    expect(lib).not.toMatch(/SETUSER\s+'?default/);
    expect(lib).not.toMatch(/>\$\{?password/);
  });
});
