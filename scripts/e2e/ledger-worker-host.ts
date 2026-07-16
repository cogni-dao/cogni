// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `scripts/e2e/ledger-worker-host`
 * Purpose: Run the REAL ledger Temporal worker (ledger-tasks) on the HOST for the finalize→mint→claim harness, reading an off-tree AUGMENTED repo-spec (distributions activated) so the R3 cumulative-root build runs instead of silently skipping.
 * Scope: Thin entrypoint. Reuses the production container + worker verbatim (createAttributionContainer + startAttributionWorker). The ONLY difference vs services/scheduler-worker/src/main.ts is (1) it starts ONLY the ledger worker (no scheduler worker → no node-endpoint noise) and (2) it chdir's to HARNESS_SPEC_DIR so loadRepoSpecIdentity() reads the augmented spec at that cwd. Never sends an on-chain tx (the fold only BUILDS + persists the manifest).
 * Invariants:
 * - REUSES_PROD_CODE: no forked finalize logic — the same createAttributionActivities the docker worker registers.
 * - READS_AUGMENTED_SPEC: HARNESS_SPEC_DIR must contain .cogni/repo-spec.yaml with distributions.status:active + governance.token_contract/emissions_holder.
 * Side-effects: IO (Temporal worker, database reads/writes to the ledger manifest tables)
 * Links: services/scheduler-worker/src/main.ts, services/scheduler-worker/src/ledger-worker.ts, scripts/e2e/finalize-mint-claim.ts
 */

import { createAttributionContainer } from "../../services/scheduler-worker/src/bootstrap/container.js";
import { env } from "../../services/scheduler-worker/src/bootstrap/env.js";
import { startAttributionWorker } from "../../services/scheduler-worker/src/ledger-worker.js";
import { makeLogger } from "../../services/scheduler-worker/src/observability/logger.js";

async function main(): Promise<void> {
  // Read the augmented off-tree repo-spec (distributions activated) instead of
  // the tracked .cogni/repo-spec.yaml. loadRepoSpecIdentity() reads
  // path.join(process.cwd(), ".cogni", "repo-spec.yaml"); chdir here (after all
  // imports have resolved via the module graph, which is cwd-independent) so the
  // container sees a non-null tokenAddress + walletResolver.
  const specDir = process.env.HARNESS_SPEC_DIR;
  if (!specDir) {
    throw new Error(
      "HARNESS_SPEC_DIR is required (dir containing .cogni/repo-spec.yaml)"
    );
  }
  process.chdir(specDir);

  const config = env();
  const logger = makeLogger({ component: "harness-ledger-worker" });

  if (!config.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the harness ledger worker");
  }

  const container = createAttributionContainer(config, logger);
  if (!container) {
    throw new Error(
      "createAttributionContainer returned null — check DATABASE_URL / repo-spec"
    );
  }

  if (!container.tokenAddress || !container.walletResolver) {
    throw new Error(
      "Distributions NOT activated in the augmented repo-spec — tokenAddress/walletResolver is null. " +
        "The R3 cumulative build would silently skip. Check HARNESS_SPEC_DIR/.cogni/repo-spec.yaml."
    );
  }

  logger.info(
    {
      nodeId: container.nodeId,
      scopeId: container.scopeId,
      chainId: container.chainId,
      tokenAddress: container.tokenAddress,
      distributorAddress: container.distributorAddress,
      walletResolver: "active",
    },
    "harness ledger worker — distributions ACTIVE, starting"
  );

  const worker = await startAttributionWorker({
    env: config,
    logger,
    container,
  });

  // Signal readiness on stdout so the orchestrator can gate the finalize dispatch
  // on an actually-polling worker (belt-and-suspenders with describeTaskQueue).
  console.log("HARNESS_LEDGER_WORKER_READY");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "harness ledger worker shutting down");
    await worker.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("harness ledger worker failed:", err);
  process.exit(1);
});
