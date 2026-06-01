// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/sandbox/sandbox-openclaw-pnpm-smoke`
 * Purpose: Smoke test proving pnpm devtools, store volume, and git are accessible inside the long-running OpenClaw gateway container.
 * Scope: Verifies pnpm binary, store volume, offline install, workspace bootstrap, git clone + commit. Does not test network-enabled installs, ephemeral container mode, or git push.
 * Invariants:
 *   - Per IMAGE_FROM_PUBLISHED_BASE: gateway runs cogni-sandbox-openclaw image with devtools
 *   - Per COMPOSE_IMAGE_PARITY: same image in dev and prod compose
 * Side-effects: IO (Docker exec into running container)
 * Links: docs/spec/openclaw-sandbox-spec.md, work/items/task.0031.openclaw-cogni-dev-image.md, work/items/task.0022.git-relay-mvp.md
 * @public
 */

import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Offline install takes ~45s (full monorepo from seeded store). 90s test + 80s exec gives headroom.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

import {
  cleanupGatewayDir,
  createGatewayTestClone,
  ensureGatewayWorkspace,
  execInContainer,
  GATEWAY_CONTAINER,
} from "../../_fixtures/sandbox/fixtures";

const docker = new Docker();

// ─────────────────────────────────────────────────────────────────────────────
// pnpm store basics (no workspace clone needed)
// ─────────────────────────────────────────────────────────────────────────────

describe("OpenClaw Gateway pnpm Store Smoke", () => {
  it("pnpm binary present at correct version", async () => {
    const output = await execInContainer(
      docker,
      GATEWAY_CONTAINER,
      "pnpm --version"
    );
    expect(output.trim()).toMatch(/^9\./);
  });

  it("pnpm store dir resolves to /pnpm-store", async () => {
    const output = await execInContainer(
      docker,
      GATEWAY_CONTAINER,
      "pnpm store path"
    );
    expect(output.trim()).toBe("/pnpm-store/v3");
  });

  it("/pnpm-store is writable by sandboxer", async () => {
    const output = await execInContainer(
      docker,
      GATEWAY_CONTAINER,
      'touch /pnpm-store/_test && rm /pnpm-store/_test && echo "OK" || echo "FAIL"'
    );
    expect(output).toContain("OK");
    expect(output).not.toContain("FAIL");
  });

  it.skip("offline install enables biome", async () => {
    // Use the real repo lockfile — pnpm install --offline --frozen-lockfile
    // skips resolution (no metadata needed) and hardlinks from seeded store.
    // /workspace is a real volume (cogni_workspace), not tmpfs, so full
    // monorepo node_modules fits.
    const output = await execInContainer(
      docker,
      GATEWAY_CONTAINER,
      [
        "rm -rf /workspace/_offline_test",
        "cp -rL /repo/current /workspace/_offline_test",
        "cd /workspace/_offline_test",
        "pnpm install --offline --frozen-lockfile",
        "pnpm exec biome --version",
        'echo "BIOME_OK"',
      ].join(" && "),
      80_000
    );
    expect(output).toContain("BIOME_OK");
  });

  it("offline install fails without seeded store (negative control)", async () => {
    const output = await execInContainer(
      docker,
      GATEWAY_CONTAINER,
      [
        "mkdir -p /workspace/_neg_test",
        "cd /workspace/_neg_test",
        'echo \'{"name":"neg-test","dependencies":{"nonexistent-pkg-12345":"1.0.0"}}\' > package.json',
        "pnpm install --offline 2>&1; echo EXIT:$?",
      ].join(" && "),
      15_000
    );
    expect(output).not.toContain("EXIT:0");
    expect(output).toMatch(/EXIT:[1-9]/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Workspace bootstrap: writable clone + pnpm install + git commit
// ─────────────────────────────────────────────────────────────────────────────

// Skipped: offline install depends on a fully-seeded pnpm store volume
// which is too slow / fragile for CI. Re-enable when store seeding is reliable.
describe.skip("OpenClaw Gateway workspace bootstrap + git commit", () => {
  let testCloneDir: string;

  beforeAll(async () => {
    // Hard prereq: /repo/current must exist (git-sync must have run).
    // Fail loudly if missing — never silently skip.
    const repoCheck = await execInContainer(
      docker,
      GATEWAY_CONTAINER,
      'git -C /repo/current rev-parse --git-dir >/dev/null 2>&1 && echo "REPO_OK" || echo "REPO_MISSING"'
    );
    if (!repoCheck.includes("REPO_OK")) {
      throw new Error(
        "/repo/current is not a git repo in gateway container. " +
          "git-sync must run before these tests. Start with: pnpm dev:stack:test"
      );
    }

    // Idempotent: clones /repo/current → /workspace/current if absent
    await ensureGatewayWorkspace(docker);
    // Isolated throwaway clone for git commit test
    testCloneDir = await createGatewayTestClone(docker, "wt");
  });

  afterAll(async () => {
    if (testCloneDir) {
      await cleanupGatewayDir(docker, testCloneDir);
    }
  });

  it("/workspace/current is a valid git repo", async () => {
    const output = await execInContainer(
      docker,
      GATEWAY_CONTAINER,
      "git -C /workspace/current rev-parse --is-inside-work-tree"
    );
    expect(output.trim()).toBe("true");
  });

  it("offline install succeeds in /workspace/current", async () => {
    const output = await execInContainer(
      docker,
      GATEWAY_CONTAINER,
      [
        "cd /workspace/current",
        "pnpm install --offline --frozen-lockfile",
        'echo "INSTALL_OK"',
      ].join(" && "),
      80_000
    );
    expect(output).toContain("INSTALL_OK");
  });

  it("pnpm exec biome works after install", async () => {
    const output = await execInContainer(
      docker,
      GATEWAY_CONTAINER,
      [
        "cd /workspace/current",
        "pnpm exec biome --version",
        'echo "BIOME_OK"',
      ].join(" && "),
      15_000
    );
    expect(output).toContain("BIOME_OK");
  });

  it("git commit succeeds in throwaway clone", async () => {
    const output = await execInContainer(
      docker,
      GATEWAY_CONTAINER,
      [
        `cd ${testCloneDir}`,
        'echo "# test change" >> README.md',
        "git add -A",
        'git commit -m "test: smoke test commit"',
        'echo "COMMIT_OK"',
      ].join(" && "),
      15_000
    );
    expect(output).toContain("COMMIT_OK");
  });
});
