// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/test-env-view`
 * Purpose: Project one test env's durable rows (desired, release, attempts) into the `GET /api/v2/test-envs/{id}`
 *   read model (story.5159). It reuses `buildWorkloadView`, the projection the v1 reads already use, so there is no
 *   second state machine to drift from the sequencer's truth.
 * Scope: Pure. Kept apart from `test-env.ts` because `release-view` imports the sequencer and the sequencer imports
 *   `test-env`.
 * Invariants:
 *   - REQUEST_TO_READY: `requestedAt` is the release row's `createdAt` (the POST instant) and `readyAt` its first
 *     activation, so `readyMs` equals the lead time `deploy.lead-time@1` aggregates.
 *   - EXPIRES_ONLY_WHILE_RUNNING: `expiresAt` is `updatedAt + TEST_ENV_TTL_MS` for a running row, else null.
 * Side-effects: none
 * Links: features/node-deploy/release-view.ts, contracts/test-envs.v2.contract.ts
 * @public
 */

import type { TestEnvRead } from "@/contracts/test-envs.v2.contract";
import type { AttemptRow, DesiredRow, ReleaseRow } from "@/ports";

import { buildWorkloadView } from "./release-view";
import { TEST_ENV_LABEL_ENV, TEST_ENV_TTL_MS, testEnvState } from "./test-env";

export function buildTestEnvRead(input: {
  readonly desired: DesiredRow;
  readonly release: ReleaseRow | undefined;
  readonly attemptsNewestFirst: readonly AttemptRow[];
}): TestEnvRead {
  const { desired, release, attemptsNewestFirst } = input;
  const view = buildWorkloadView({ desired, release, attemptsNewestFirst });
  const spec = release?.spec;
  return {
    testEnvId: desired.workload,
    nodeId: desired.nodeId,
    sourceSha: release?.sourceSha ?? "",
    host: spec && "http" in spec.expose ? spec.expose.http.host : null,
    label: spec?.env?.[TEST_ENV_LABEL_ENV] ?? null,
    state: testEnvState({
      desiredState: desired.state,
      releaseState: view.desired.releaseState,
      attempts: attemptsNewestFirst,
    }),
    requestedAt: view.desired.recordedAt,
    readyAt: view.desired.activatedAt,
    readyMs: view.desired.leadTimeMs,
    expiresAt:
      desired.state === "running"
        ? new Date(desired.updatedAt.getTime() + TEST_ENV_TTL_MS).toISOString()
        : null,
  };
}
