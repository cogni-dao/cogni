#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@scripts/ops/prove-maintenance-cancellation`
 * Purpose: One bounded candidate integration test of the public cancellation route.
 * Scope: Own test-App custody and fixed test ref; does not deploy or repair the auxiliary runtime.
 * Invariants: no canonical writes, secret output, runtime tree changes or force updates.
 * Side-effects: IO (test GitHub ref, candidate HTTP); cleanup owns only its exact fixture.
 * Links: task.5345, ordinary-node-delivery-boundary design4
 * @internal
 */
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

async function main() {
  // Run inside the candidate app's existing custody and /app dependency directory.
  // stdin is JSON {apiKey, expectedOperatorSha}; do not place a bearer in argv or a file.
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
  const { apiKey, expectedOperatorSha } = JSON.parse(stdin);
  stdin = "";
  requireThat(
    typeof apiKey === "string" && apiKey.length > 0,
    "own_candidate_bearer_required"
  );
  requireThat(
    typeof expectedOperatorSha === "string" &&
      /^[a-f0-9]{40}$/.test(expectedOperatorSha),
    "exact_operator_source_required"
  );
  const baseline = new URL("https://test.cognidao.org/");
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
  async function content(path, ref, cleanup = false) {
    try {
      const d = await gh(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
          path,
          ref,
        },
        cleanup
      );
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
  async function observe(cleanup = false) {
    const [version, ready] = await Promise.all(
      ["version", "readyz"].map((p) =>
        fetch(new URL(p, baseline), {
          signal: AbortSignal.any([
            cleanup ? cleanupSignal : deadline.signal,
            AbortSignal.timeout(5000),
          ]),
        })
      )
    );
    requireThat(version.ok && ready.ok, "operator_baseline_unhealthy");
    const v = await version.json();
    requireThat(v.buildSha === expectedOperatorSha, "operator_source_mismatch");
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
  let failure;
  let cancellation;
  const safeError = (error) =>
    /^[a-z_]+$/.test(error?.message ?? "") ? error.message : "fixture_failed";
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
    emit("fixture_transition", {
      head: ownedHead,
      markerSha256: bytes === null ? null : hash(bytes),
      cleanup,
    });
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
    cancellation = valid.body;
    ownedHead = valid.body.commitSha;
    ownedBytes = null;
    requireThat(
      (await head()) === ownedHead &&
        (await tree(ownedHead)) === baselineTree &&
        (await content(markerPath, ownedHead)) === null,
      "cancellation_readback_failed"
    );
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    cleanupSignal = AbortSignal.timeout(20000);
    let residualHead = null;
    let residualMarkerSha256 = null;
    try {
      if (ownedHead) {
        const actualHead = await head(true);
        residualHead = actualHead;
        // Read an ambiguous remote update back, never overwrite uncertain state.
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
        requireThat(residualHead === ownedHead, "cleanup_ownership_conflict");
        const bytes = await content(markerPath, ownedHead, true);
        residualMarkerSha256 = bytes === null ? null : hash(bytes);
        requireThat(bytes === ownedBytes, "cleanup_marker_conflict");
        await replaceMarker(null, true);
        emit("fixture_cleanup_complete", { head: ownedHead, baselineTree });
      }
      if (ownedHead) {
        residualHead = await head(true);
        requireThat(
          (await tree(residualHead, true)) === baselineTree,
          "final_tree_changed"
        );
        requireThat(
          (await content(markerPath, residualHead, true)) === null,
          "final_marker_present"
        );
      }
      if (cancellation && !failure) {
        requireThat(
          residualHead === cancellation.commitSha,
          "cancellation_head_changed"
        );
        requireThat(
          (await observe(true)) === baselineSha,
          "operator_source_changed"
        );
        success = true;
      }
    } catch (cleanupError) {
      // Best-effort bounded readback: null means unproven, never assumed absent.
      let residualReadbackError = null;
      try {
        residualHead = await head(true);
        const bytes = await content(markerPath, residualHead, true);
        residualMarkerSha256 = bytes === null ? null : hash(bytes);
      } catch (readError) {
        residualReadbackError = safeError(readError);
      }
      emit("fixture_cleanup_failed", {
        ownedHead,
        ownedMarkerSha256: ownedBytes === null ? null : hash(ownedBytes),
        residualHead,
        residualMarkerSha256,
        residualReadbackError,
        originalError: failure ? safeError(failure) : null,
        cleanupError: safeError(cleanupError),
      });
      if (!failure) failure = cleanupError;
    }
    emit("fixture_finished", { success, head: residualHead });
  }
  if (failure) throw failure;
  requireThat(success, "fixture_incomplete");
  // API/cleanup proof only; independent watcher/spec/guard/Loki checks still gate PASS.
  emit("public_cancellation_complete", {
    fixtureHead: cancellation.previousHead,
    commitSha: cancellation.commitSha,
    baselineTree,
    operatorSha: baselineSha,
  });
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
