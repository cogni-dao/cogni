#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@scripts/ops/prove-maintenance-cancellation`
 * Purpose: One bounded candidate integration test of the public cancellation route.
 * Scope: Own test-App custody; fixed test node/ref; marker-only setup/teardown.
 * Invariants: no canonical writes, secret output, runtime tree changes or force updates.
 * Side-effects: IO (test GitHub ref, candidate HTTP); cleanup owns only its exact fixture.
 * Links: task.5345, ordinary-node-delivery-boundary design3
 * @internal
 */
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

async function main() {
  // Run inside the candidate app's existing custody and /app dependency directory.
  // stdin is JSON {apiKey, baselineUrl}; do not place a bearer in argv or a file.
  const require = createRequire(`${process.cwd()}/package.json`);
  const { Octokit } = require("@octokit/core");
  const { createAppAuth } = require("@octokit/auth-app");
  const { parse } = require("yaml");
  const owner = "cogni-test-org",
    repo = "cogni-monorepo",
    slug = "node-template";
  const nodeId = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c",
    branch = "deploy/candidate-a-node-template";
  const markerPath = ".promote-state/maintenance-drain.json";
  const requireThat = (value, code) => {
    if (!value) throw new Error(code);
  };
  requireThat(
    process.env.DEPLOY_ENVIRONMENT === "candidate-a" &&
      process.env.NODE_SUBMODULE_PARENT_OWNER === owner &&
      process.env.NODE_SUBMODULE_PARENT_REPO === repo,
    "test_custody_required"
  );
  let stdin = "";
  for await (const part of process.stdin) {
    stdin += part;
    requireThat(stdin.length < 16384, "input_too_large");
  }
  const { apiKey, baselineUrl } = JSON.parse(stdin);
  stdin = "";
  requireThat(
    typeof apiKey === "string" && apiKey.length > 0,
    "own_candidate_bearer_required"
  );
  const baseline = new URL(baselineUrl);
  requireThat(
    !baseline.username &&
      !baseline.password &&
      baseline.pathname === "/" &&
      !baseline.search &&
      !baseline.hash &&
      ((baseline.protocol === "https:" &&
        baseline.hostname.endsWith(".cogni-testing.org")) ||
        (baseline.protocol === "http:" &&
          baseline.hostname ===
            "node-template-node-app.cogni-candidate-a.svc.cluster.local")),
    "isolated_test_baseline_required"
  );
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 240000);
  timer.unref();
  const appAuth = createAppAuth({
    appId: process.env.GH_REVIEW_APP_ID,
    privateKey: Buffer.from(
      process.env.GH_REVIEW_APP_PRIVATE_KEY_BASE64 ?? "",
      "base64"
    ).toString("utf8"),
  });
  const app = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: process.env.GH_REVIEW_APP_ID,
      privateKey: Buffer.from(
        process.env.GH_REVIEW_APP_PRIVATE_KEY_BASE64 ?? "",
        "base64"
      ).toString("utf8"),
    },
  });
  const installation = await app.request(
    "GET /repos/{owner}/{repo}/installation",
    {
      owner,
      repo,
      request: {
        signal: AbortSignal.any([deadline.signal, AbortSignal.timeout(10000)]),
      },
    }
  );
  const { token } = await appAuth({
    type: "installation",
    installationId: installation.data.id,
  });
  const github = new Octokit({ auth: token });
  let cleanupSignal;
  async function gh(route, params = {}, cleanup = false) {
    return (
      await github.request(route, {
        owner,
        repo,
        ...params,
        request: {
          signal: cleanup
            ? cleanupSignal
            : AbortSignal.any([deadline.signal, AbortSignal.timeout(10000)]),
        },
      })
    ).data;
  }
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const operationId = hash(`candidate-maintenance-proof:${randomUUID()}`);
  const emit = (event, fields = {}) =>
    console.log(
      JSON.stringify({
        event,
        fixture: "candidate-maintenance-proof",
        operationId,
        ...fields,
      })
    );
  async function head(cleanup = false) {
    return (
      await gh(
        "GET /repos/{owner}/{repo}/git/ref/{ref}",
        { ref: `heads/${branch}` },
        cleanup
      )
    ).object.sha;
  }
  async function content(path, ref) {
    try {
      const d = await gh("GET /repos/{owner}/{repo}/contents/{path}", {
        path,
        ref,
      });
      requireThat(d.type === "file" && d.encoding === "base64", "invalid_file");
      return Buffer.from(d.content, "base64").toString("utf8");
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }
  async function tree(sha, cleanup = false) {
    return (
      await gh(
        "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
        { commit_sha: sha },
        cleanup
      )
    ).tree.sha;
  }
  async function inventory() {
    for (const status of [
      "requested",
      "waiting",
      "pending",
      "queued",
      "in_progress",
      "action_required",
    ]) {
      const r = await gh("GET /repos/{owner}/{repo}/actions/runs", {
        status,
        per_page: 100,
      });
      requireThat(
        r.total_count < 100 && r.workflow_runs.length === 0,
        "test_delivery_not_quiescent"
      );
    }
  }
  async function observe() {
    const [version, ready] = await Promise.all(
      ["version", "readyz"].map((p) =>
        fetch(new URL(p, baseline), { signal: AbortSignal.timeout(5000) })
      )
    );
    requireThat(version.ok && ready.ok, "test_baseline_unhealthy");
    const v = await version.json();
    requireThat(
      /^[a-f0-9]{40}$/.test(v.buildSha),
      "test_baseline_sha_unproven"
    );
    return v.buildSha;
  }
  async function call(body) {
    const r = await fetch(
      "https://test.cognidao.org/api/v1/deploy/maintenance-cancel",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([deadline.signal, AbortSignal.timeout(20000)]),
      }
    );
    return { status: r.status, body: await r.json() };
  }
  let ownedHead = null,
    ownedBytes = null,
    baselineTree = null,
    baseHead = null,
    baselineSha = null;
  let success = false;
  let pendingTransition = null;
  async function replaceMarker(bytes, cleanup = false) {
    requireThat((await head(cleanup)) === ownedHead, "fixture_head_changed");
    const previous = ownedHead;
    const t = await gh(
      "POST /repos/{owner}/{repo}/git/trees",
      {
        base_tree: await tree(previous, cleanup),
        tree: [
          bytes === null
            ? { path: markerPath, type: "blob", mode: "100644", sha: null }
            : {
                path: markerPath,
                type: "blob",
                mode: "100644",
                content: bytes,
              },
        ],
      },
      cleanup
    );
    if (bytes === null)
      requireThat(t.sha === baselineTree, "fixture_cleanup_tree_mismatch");
    const c = await gh(
      "POST /repos/{owner}/{repo}/git/commits",
      {
        parents: [previous],
        tree: t.sha,
        message: `test(candidate-a): maintenance cancellation fixture ${operationId}\n\nMarker-SHA256: ${bytes === null ? "removed" : hash(bytes)}`,
      },
      cleanup
    );
    pendingTransition = { head: c.sha, bytes };
    await gh(
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}",
      { ref: `heads/${branch}`, sha: c.sha, force: false },
      cleanup
    );
    ownedHead = c.sha;
    ownedBytes = bytes;
    pendingTransition = null;
    return c.sha;
  }
  try {
    const catalog = parse(await content(`infra/catalog/${slug}.yaml`, "main"));
    requireThat(
      catalog?.node_id === nodeId &&
        catalog?.candidate_a_branch === branch &&
        catalog?.source_repo ===
          "https://github.com/cogni-test-org/node-template.git",
      "test_catalog_mismatch"
    );
    await inventory();
    baseHead = await head();
    baselineTree = await tree(baseHead);
    baselineSha = await observe();
    requireThat(
      (await content(markerPath, baseHead)) === null &&
        (await content(
          ".promote-state/maintenance-drain-receipt.json",
          baseHead
        )) === null,
      "existing_intent_or_receipt"
    );
    const body = {
      nodeId,
      env: "candidate-a",
      operationId,
      expectedDeployHead: "0".repeat(40),
      expectedMarkerSha256: "0".repeat(64),
      reason: "Candidate integration fixture",
    };
    const auth = await call(body);
    requireThat(
      auth.status === 409 && auth.body.error === "maintenance_head_conflict",
      "candidate_authority_not_proven"
    );
    // All authority/health checks precede the first fixture write.
    ownedHead = baseHead;
    const marker = {
      version: 1,
      phase: "fenced",
      operationId,
      request: {
        nodeId,
        slug,
        env: "candidate-a",
        sourceRepository: "cogni-test-org/node-template",
        expected: { deployCommit: baseHead },
      },
      phaseEvidence: { phase: "fenced", nodeId, environment: "candidate-a" },
    };
    await inventory();
    await replaceMarker(JSON.stringify(marker));
    emit("fixture_created", {
      baseHead,
      fixtureHead: ownedHead,
      baselineTree,
      baselineSha,
    });
    for (const bad of [
      { expectedDeployHead: baseHead },
      { expectedMarkerSha256: "0".repeat(64) },
      { operationId: "0".repeat(64) },
    ]) {
      const before = ownedHead;
      const r = await call({
        ...body,
        expectedDeployHead: ownedHead,
        expectedMarkerSha256: hash(ownedBytes),
        ...bad,
      });
      requireThat(
        r.status === 409 && (await head()) === before,
        "negative_changed_state"
      );
    }
    await replaceMarker(JSON.stringify({ ...marker, phase: "drained" }));
    const advanced = await call({
      ...body,
      expectedDeployHead: ownedHead,
      expectedMarkerSha256: hash(ownedBytes),
    });
    requireThat(
      advanced.status === 409 && (await head()) === ownedHead,
      "advanced_phase_accepted"
    );
    await replaceMarker(JSON.stringify(marker));
    const valid = await call({
      ...body,
      expectedDeployHead: ownedHead,
      expectedMarkerSha256: hash(ownedBytes),
    });
    requireThat(
      valid.status === 200 &&
        valid.body.previousHead === ownedHead &&
        valid.body.operationId === operationId,
      "public_cancellation_failed"
    );
    ownedHead = valid.body.commitSha;
    ownedBytes = null;
    requireThat(
      (await head()) === ownedHead &&
        (await tree(ownedHead)) === baselineTree &&
        (await content(markerPath, ownedHead)) === null,
      "cancellation_readback_failed"
    );
    requireThat((await observe()) === baselineSha, "serving_sha_changed");
    success = true;
    emit("public_cancellation_pass", {
      commitSha: ownedHead,
      baselineTree,
      baselineSha,
    });
  } finally {
    clearTimeout(timer);
    cleanupSignal = AbortSignal.timeout(20000);
    if (ownedHead) {
      const actualHead = await head(true);
      // A successful remote update may lose its HTTP response. Read it back;
      // never retry or overwrite a branch from an uncertain old head.
      if (pendingTransition && actualHead === pendingTransition.head) {
        ownedHead = actualHead;
        ownedBytes = pendingTransition.bytes;
      }
      if ((await tree(actualHead, true)) === baselineTree) {
        ownedHead = actualHead;
        ownedBytes = null;
      }
    }

    if (ownedBytes !== null) {
      // Only the exact head/bytes created by this harness are ours to remove.
      requireThat(
        (await head(true)) === ownedHead,
        "cleanup_ownership_conflict"
      );
      const d = await gh(
        "GET /repos/{owner}/{repo}/contents/{path}",
        { path: markerPath, ref: ownedHead },
        true
      );
      requireThat(
        d.type === "file" &&
          d.encoding === "base64" &&
          Buffer.from(d.content, "base64").toString("utf8") === ownedBytes,
        "cleanup_marker_conflict"
      );
      await replaceMarker(null, true);
      emit("fixture_cleanup_complete", { head: ownedHead, baselineTree });
    }
    if (ownedHead)
      requireThat(
        (await tree(await head(true), true)) === baselineTree,
        "final_tree_changed"
      );
    emit("fixture_finished", { success, head: ownedHead });
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      event: "candidate_maintenance_proof_failed",
      error: /^[a-z_]+$/.test(error?.message ?? "")
        ? error.message
        : "fixture_failed",
    })
  );
  process.exitCode = 1;
});
