#!/usr/bin/env tsx

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/db/seed`
 * Purpose: Dev seed script for governance and profile UI — populates attribution
 * ledger data with claimant-aware, linked/unlinked GitHub contributors.
 * Scope: Seeds linked users + GitHub bindings, epochs (2 finalized, 1 review,
 * 1 open), ingestion receipts, and downstream ledger data for local dev.
 * Open epoch seeds receipts only — selections, projections, and claimants
 * are created by the pipeline when triggered via dev:trigger-github.
 * Does not modify production databases or run in CI.
 * Invariants:
 * - ONE_OPEN_EPOCH: only one open epoch per node/scope
 * - LINKED_USERS_HAVE_BINDINGS: linked humans are seeded in users +
 *   user_bindings, not just via resolved selections
 * - FINALIZED_EPOCHS_HAVE_LOCKED_CLAIMANTS: finalized seed data uses
 *   the receipt-claimant model, not legacy evaluation-based statements
 * - UNCLAIMED_IDENTITIES_VISIBLE: some GitHub contributors stay unresolved and
 *   never get a local user row
 * Side-effects: IO (database writes, console output)
 * Links: work/items/task.0106.ledger-dev-seed.md
 * @public
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type AttributionStatementLineRecord,
  computeApproverSetHash,
  computeArtifactsHash,
  computeAttributionStatementLines,
  computeEnricherInputsHash,
  computeEpochWindowV1,
  computeFinalClaimantAllocationSetHash,
  computeReceiptWeights,
  computeWeightConfigHash,
  deriveAllocationAlgoRef,
  explodeToClaimants,
  type InsertReceiptClaimantsParams,
  type ReceiptClaimantsRecord,
  type SelectedReceiptForAttribution,
  type UpsertEvaluationParams,
} from "@cogni/attribution-ledger";
import { DrizzleAttributionAdapter } from "@cogni/db-client";
import { createServiceDbClient } from "@cogni/db-client/service";
import {
  billingAccounts,
  chargeReceipts,
  executionGrants,
  graphRuns,
  llmChargeDetails,
  schedules,
  virtualKeys,
} from "@cogni/db-schema";
import { identityEvents, userBindings } from "@cogni/db-schema/identity";
import { users } from "@cogni/db-schema/refs";
import { extractNodeId, extractScopeId, parseRepoSpec } from "@cogni/repo-spec";
import { and, eq } from "drizzle-orm";

// ── Configuration ───────────────────────────────────────────────

const repoRoot = path.resolve(import.meta.dirname, "../..");
const repoSpecContent = fs.readFileSync(
  path.join(repoRoot, ".cogni", "repo-spec.yaml"),
  "utf8"
);
const repoSpec = parseRepoSpec(repoSpecContent);

const REPO_REF = "Cogni-DAO/cogni";
const NODE_ID = extractNodeId(repoSpec);
const SCOPE_ID = extractScopeId(repoSpec);
// Must match cogni-v0.0 profile defaultWeightConfig
const WEIGHT_CONFIG: Record<string, number> = {
  "github:pr_merged": 1000,
  "github:review_submitted": 0,
  "github:issue_closed": 0,
};
// The pinned approver set for seeded review epochs. Overridable via the
// SEED_APPROVERS env var (comma-separated addresses) so the local finalize→
// mint→claim harness (scripts/e2e/finalize-mint-claim.ts) can pin an anvil
// account whose key it holds and sign the EIP-712 finalize statement with no
// MetaMask. The approverSetHash the seed pins is computed from THIS list, so an
// override stays internally consistent. Defaults to the historical seed wallet.
const SEED_APPROVERS = (process.env.SEED_APPROVERS ?? "")
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean);
if (SEED_APPROVERS.length === 0) {
  SEED_APPROVERS.push("0x070075F1389Ae1182aBac722B36CA12285d0c949");
}
const ALLOCATION_ALGO_REF = deriveAllocationAlgoRef("cogni-v0.0");
const CLAIMANT_RESOLVER_REF = "cogni.default-author.v0";
const CLAIMANT_ALGO_REF = "default-author-v0";
const ECHO_EVALUATION_REF = "cogni.echo.v0";
const ECHO_ALGO_REF = "echo-v0";
const PRODUCER = "dev-seed";
const PRODUCER_VERSION = "0.1.0-seed";

// ── Contributors ────────────────────────────────────────────────

interface SeedContributor {
  platformUserId: string;
  login: string;
  userId: string | null;
  name: string;
}

function seedUserIdFromGitHubId(platformUserId: string): string {
  return `d0000000-0000-4000-a000-${platformUserId.padStart(12, "0")}`;
}

function linkedContributor(params: {
  platformUserId: string;
  login: string;
  name: string;
}): SeedContributor {
  return {
    ...params,
    userId: seedUserIdFromGitHubId(params.platformUserId),
  };
}

function unlinkedContributor(params: {
  platformUserId: string;
  login: string;
  name: string;
}): SeedContributor {
  return {
    ...params,
    userId: null,
  };
}

const DEREK = unlinkedContributor({
  platformUserId: "58641509",
  login: "derekg1729",
  name: "Derek G",
});

const ALICE = linkedContributor({
  platformUserId: "90000101",
  login: "alice-vector",
  name: "Alice Vector",
});

const BEN = linkedContributor({
  platformUserId: "90000102",
  login: "ben-rivera",
  name: "Ben Rivera",
});

const MIRA = unlinkedContributor({
  platformUserId: "90000103",
  login: "mira-stone",
  name: "Mira Stone",
});

const COGNI = unlinkedContributor({
  platformUserId: "207977700",
  login: "Cogni-1729",
  name: "Cogni (AI Agent)",
});

// flock-leader (Cogni's external agent account). Seeded UNLINKED so the walk
// distribution e2e demonstrates conservation: a contributor with no
// wallet-resolved binding is recorded + visible but excluded from this epoch's
// mint (pending until a wallet is linked) — vs derekg1729, who links a wallet
// in-app and claims.
const FLOCK = unlinkedContributor({
  platformUserId: "295942454",
  login: "flock-leader",
  name: "Flock Leader (Agent)",
});

const LINKED_CONTRIBUTORS = [ALICE, BEN] as const;

// ── Helpers ─────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function payloadHash(data: Record<string, unknown>): string {
  const canonical = JSON.stringify(data, Object.keys(data).sort());
  return sha256(canonical);
}

function epochWindowWeeksAgo(weeksAgo: number): {
  periodStart: Date;
  periodEnd: Date;
} {
  const asOf = new Date(Date.now() - weeksAgo * 7 * 86_400_000);
  const { periodStartIso, periodEndIso } = computeEpochWindowV1({
    asOfIso: asOf.toISOString(),
    epochLengthDays: 7,
    timezone: "UTC",
    weekStart: "monday",
  });
  return {
    periodStart: new Date(periodStartIso),
    periodEnd: new Date(periodEndIso),
  };
}

function daysBefore(ref: Date, days: number): Date {
  return new Date(ref.getTime() - days * 86_400_000);
}

/** Build the claimant key for a contributor (matches claimantKey() in attribution-ledger). */
function contributorClaimantKey(contributor: SeedContributor): string {
  if (contributor.userId) return `user:${contributor.userId}`;
  return `identity:github:${contributor.platformUserId}`;
}

// ── Seed Data ───────────────────────────────────────────────────

interface EventDef {
  id: string;
  source: "github";
  eventType: "pr_merged" | "review_submitted";
  contributor: SeedContributor;
  artifactUrl: string;
  title: string;
  eventTime: Date;
  metadata: Record<string, unknown>;
}

interface SeedEpochDef {
  periodStart: Date;
  periodEnd: Date;
  poolCredits: bigint;
  events: readonly EventDef[];
}

function prEvent(params: {
  number: number;
  title: string;
  contributor: SeedContributor;
  eventTime: Date;
  reassignedFrom?: string;
}): EventDef {
  return {
    id: `github:pr:${REPO_REF}:${params.number}`,
    source: "github",
    eventType: "pr_merged",
    contributor: params.contributor,
    artifactUrl: `https://github.com/${REPO_REF}/pull/${params.number}`,
    title: params.title,
    eventTime: params.eventTime,
    metadata: {
      repo: REPO_REF,
      ...(params.reassignedFrom
        ? { seedReassignedFrom: params.reassignedFrom }
        : {}),
    },
  };
}

function reviewEvent(params: {
  prNumber: number;
  reviewDatabaseId: number;
  title: string;
  contributor: SeedContributor;
  eventTime: Date;
  state?: string;
}): EventDef {
  const state = params.state ?? "APPROVED";
  return {
    id: `github:review:${REPO_REF}:${params.prNumber}:${params.reviewDatabaseId}`,
    source: "github",
    eventType: "review_submitted",
    contributor: params.contributor,
    artifactUrl: `https://github.com/${REPO_REF}/pull/${params.prNumber}#pullrequestreview-${params.reviewDatabaseId}`,
    title: params.title,
    eventTime: params.eventTime,
    metadata: {
      repo: REPO_REF,
      prNumber: params.prNumber,
      state,
    },
  };
}

const WINDOW_1 = epochWindowWeeksAgo(4);
const WINDOW_2 = epochWindowWeeksAgo(3);
const WINDOW_3 = epochWindowWeeksAgo(1);
const WINDOW_4 = epochWindowWeeksAgo(0);

const EPOCH_1: SeedEpochDef = {
  periodStart: WINDOW_1.periodStart,
  periodEnd: WINDOW_1.periodEnd,
  poolCredits: 12000n,
  events: [
    prEvent({
      number: 451,
      title: "fix(gov): less frequent heartbeat, generated _index.md",
      contributor: COGNI,
      eventTime: daysBefore(WINDOW_1.periodEnd, 6),
    }),
    reviewEvent({
      prNumber: 451,
      reviewDatabaseId: 3826727409,
      title: "Review: approve PR #451",
      contributor: DEREK,
      eventTime: daysBefore(WINDOW_1.periodEnd, 6),
    }),
    prEvent({
      number: 447,
      title: "feat(openclaw): Discord channel agents with lifecycle dispatch",
      contributor: COGNI,
      eventTime: daysBefore(WINDOW_1.periodEnd, 5),
    }),
    reviewEvent({
      prNumber: 447,
      reviewDatabaseId: 3823960987,
      title: "Review: approve PR #447",
      contributor: DEREK,
      eventTime: daysBefore(WINDOW_1.periodEnd, 5),
    }),
    prEvent({
      number: 480,
      title:
        "feat(auth): backend supports multi-provider OAuth login + account linking (task.0107)",
      contributor: ALICE,
      eventTime: daysBefore(WINDOW_1.periodEnd, 4),
      reassignedFrom: "derekg1729",
    }),
    prEvent({
      number: 482,
      title:
        "feat(ui): add sidebar layout, mobile polish, OC-inspired table primitives",
      contributor: BEN,
      eventTime: daysBefore(WINDOW_1.periodEnd, 3),
      reassignedFrom: "derekg1729",
    }),
    prEvent({
      number: 479,
      title: "fix(db): remove duplicate epochs migration, fix snapshot drift",
      contributor: MIRA,
      eventTime: daysBefore(WINDOW_1.periodEnd, 2),
      reassignedFrom: "derekg1729",
    }),
    prEvent({
      number: 483,
      title:
        "feat(profile): user profile scaffolding, identity DB hardening, RLS policies",
      contributor: DEREK,
      eventTime: daysBefore(WINDOW_1.periodEnd, 1),
    }),
  ],
};

const EPOCH_2: SeedEpochDef = {
  periodStart: WINDOW_2.periodStart,
  periodEnd: WINDOW_2.periodEnd,
  poolCredits: 16000n,
  events: [
    prEvent({
      number: 470,
      title:
        "feat(ledger): allocation computation, epoch auto-close, and FinalizeEpochWorkflow (task.0102)",
      contributor: DEREK,
      eventTime: daysBefore(WINDOW_2.periodEnd, 6),
    }),
    prEvent({
      number: 468,
      title:
        "feat(ledger): epoch 3-phase state machine + approvers + canonical signing (task.0100)",
      contributor: ALICE,
      eventTime: daysBefore(WINDOW_2.periodEnd, 5),
      reassignedFrom: "derekg1729",
    }),
    prEvent({
      number: 464,
      title:
        "feat(ledger): Zod contracts + API routes for epoch ledger (task.0096)",
      contributor: BEN,
      eventTime: daysBefore(WINDOW_2.periodEnd, 4),
      reassignedFrom: "derekg1729",
    }),
    prEvent({
      number: 472,
      title:
        "feat(governance): v0 epoch UI, dev data seed script, and dev:setup workflow",
      contributor: DEREK,
      eventTime: daysBefore(WINDOW_2.periodEnd, 3),
    }),
    prEvent({
      number: 475,
      title: "fix(gov): surface unresolved contributors in epoch UI (bug.0092)",
      contributor: MIRA,
      eventTime: daysBefore(WINDOW_2.periodEnd, 2),
      reassignedFrom: "derekg1729",
    }),
    prEvent({
      number: 445,
      title: "docs(dev): development lifecycle status updates, agent fixes",
      contributor: COGNI,
      eventTime: daysBefore(WINDOW_2.periodEnd, 2),
    }),
    reviewEvent({
      prNumber: 445,
      reviewDatabaseId: 3817607627,
      title: "Review: approve PR #445",
      contributor: DEREK,
      eventTime: daysBefore(WINDOW_2.periodEnd, 2),
    }),
    prEvent({
      number: 473,
      title:
        "feat(scheduler-worker): add observability modules, metrics, and event registry",
      contributor: DEREK,
      eventTime: daysBefore(WINDOW_2.periodEnd, 1),
    }),
  ],
};

const EPOCH_3: SeedEpochDef = {
  periodStart: WINDOW_3.periodStart,
  periodEnd: WINDOW_3.periodEnd,
  poolCredits: 15000n,
  events: [
    prEvent({
      number: 496,
      title: "feat(auth): oauth Signin UI and profile oauth linking v0",
      contributor: DEREK,
      eventTime: daysBefore(WINDOW_3.periodEnd, 6),
    }),
    prEvent({
      number: 494,
      title: "refactor(attribution): rename Epoch Ledger -> Attribution Ledger",
      contributor: ALICE,
      eventTime: daysBefore(WINDOW_3.periodEnd, 5),
      reassignedFrom: "derekg1729",
    }),
    prEvent({
      number: 492,
      title: "refactor(ledger): rename pipeline stages across all layers",
      contributor: BEN,
      eventTime: daysBefore(WINDOW_3.periodEnd, 4),
      reassignedFrom: "derekg1729",
    }),
    prEvent({
      number: 490,
      title:
        "feat(ledger): epoch artifact pipeline + echo enricher (task.0113)",
      contributor: DEREK,
      eventTime: daysBefore(WINDOW_3.periodEnd, 3),
    }),
    prEvent({
      number: 488,
      title:
        "feat(work): governance ideas batch - operator plane, DAO gateway, MDI partnership",
      contributor: MIRA,
      eventTime: daysBefore(WINDOW_3.periodEnd, 2),
      reassignedFrom: "derekg1729",
    }),
    prEvent({
      number: 485,
      title:
        "feat(heartbeat): replace read-only drift monitor with active branch sync",
      contributor: DEREK,
      eventTime: daysBefore(WINDOW_3.periodEnd, 2),
    }),
    prEvent({
      number: 435,
      title:
        "feat(activity): stacked bar charts, and openclaw agent raw thinking streaming",
      contributor: COGNI,
      eventTime: daysBefore(WINDOW_3.periodEnd, 1),
    }),
    reviewEvent({
      prNumber: 435,
      reviewDatabaseId: 3811406373,
      title: "Review: approve PR #435",
      contributor: DEREK,
      eventTime: daysBefore(WINDOW_3.periodEnd, 1),
    }),
    prEvent({
      number: 489,
      title: "feat(walk): cumulative distributor claim path (flock-leader)",
      contributor: FLOCK,
      eventTime: daysBefore(WINDOW_3.periodEnd, 1),
    }),
  ],
};

const EPOCH_4: SeedEpochDef = {
  periodStart: WINDOW_4.periodStart,
  periodEnd: WINDOW_4.periodEnd,
  poolCredits: 14000n,
  events: [
    prEvent({
      number: 500,
      title:
        "feat(attribution): migrate signature verification from EIP-191 to EIP-712",
      contributor: DEREK,
      eventTime: daysBefore(WINDOW_4.periodEnd, 5),
    }),
    prEvent({
      number: 498,
      title: "feat(attribution): add GET /epochs/[id]/sign-data endpoint",
      contributor: ALICE,
      eventTime: daysBefore(WINDOW_4.periodEnd, 4),
      reassignedFrom: "derekg1729",
    }),
    prEvent({
      number: 497,
      title: "docs(work): add task.0119 — epoch approver UI",
      contributor: COGNI,
      eventTime: daysBefore(WINDOW_4.periodEnd, 3),
    }),
    reviewEvent({
      prNumber: 497,
      reviewDatabaseId: 3830201455,
      title: "Review: approve PR #497",
      contributor: DEREK,
      eventTime: daysBefore(WINDOW_4.periodEnd, 3),
    }),
    prEvent({
      number: 495,
      title:
        "fix(governance): epoch history pagination and empty state handling",
      contributor: BEN,
      eventTime: daysBefore(WINDOW_4.periodEnd, 2),
      reassignedFrom: "derekg1729",
    }),
    prEvent({
      number: 493,
      title:
        "feat(profile): wallet connection status indicator and balance display",
      contributor: MIRA,
      eventTime: daysBefore(WINDOW_4.periodEnd, 2),
      reassignedFrom: "derekg1729",
    }),
    prEvent({
      number: 491,
      title: "docs(spec): update attribution ledger spec with EIP-712 signing",
      contributor: DEREK,
      eventTime: daysBefore(WINDOW_4.periodEnd, 1),
    }),
    reviewEvent({
      prNumber: 491,
      reviewDatabaseId: 3832405617,
      title: "Review: approve PR #491",
      contributor: ALICE,
      eventTime: daysBefore(WINDOW_4.periodEnd, 1),
    }),
  ],
};

// ── Receipt + claimant helpers ──────────────────────────────────

function eventPayloadHash(event: EventDef): string {
  const authorId = event.contributor.platformUserId;
  switch (event.eventType) {
    case "pr_merged":
      return payloadHash({
        authorId,
        id: event.id,
        mergedAt: event.eventTime.toISOString(),
      });
    case "review_submitted":
      return payloadHash({
        authorId,
        id: event.id,
        state: event.metadata.state ?? "APPROVED",
        submittedAt: event.eventTime.toISOString(),
      });
  }
}

function buildAttributionReceipts(
  events: readonly EventDef[]
): SelectedReceiptForAttribution[] {
  return events.map((event) => ({
    receiptId: event.id,
    userId: event.contributor.userId,
    source: event.source,
    eventType: event.eventType,
    included: true,
    weightOverrideMilli: null,
    platformUserId: event.contributor.platformUserId,
    platformLogin: event.contributor.login,
    artifactUrl: event.artifactUrl,
    eventTime: event.eventTime,
    payloadHash: eventPayloadHash(event),
  }));
}

function buildReceiptClaimantParams(
  epochId: bigint,
  events: readonly EventDef[]
): InsertReceiptClaimantsParams[] {
  return events.map((event) => ({
    nodeId: NODE_ID,
    epochId,
    receiptId: event.id,
    resolverRef: CLAIMANT_RESOLVER_REF,
    algoRef: CLAIMANT_ALGO_REF,
    inputsHash: sha256(`${event.id}:${event.contributor.platformUserId}`),
    claimantKeys: [contributorClaimantKey(event.contributor)],
    createdBy: PRODUCER,
  }));
}

function computeUserProjections(
  receipts: readonly SelectedReceiptForAttribution[],
  weightConfig: Record<string, number>
): { userId: string; projectedUnits: bigint; receiptCount: number }[] {
  const byUser = new Map<string, { units: bigint; count: number }>();

  for (const receipt of receipts) {
    if (!receipt.userId || !receipt.included) continue;

    const key = `${receipt.source}:${receipt.eventType}`;
    const weight =
      receipt.weightOverrideMilli ?? BigInt(weightConfig[key] ?? 0);

    const entry = byUser.get(receipt.userId) ?? { units: 0n, count: 0 };
    entry.units += weight;
    entry.count += 1;
    byUser.set(receipt.userId, entry);
  }

  return [...byUser.entries()]
    .map(([userId, { units, count }]) => ({
      userId,
      projectedUnits: units,
      receiptCount: count,
    }))
    .sort((a, b) => a.userId.localeCompare(b.userId));
}

async function buildClaimantAwareStatement(params: {
  receipts: readonly SelectedReceiptForAttribution[];
  claimants: readonly ReceiptClaimantsRecord[];
  poolCredits: bigint;
}): Promise<{
  finalAllocationSetHash: string;
  statementLines: AttributionStatementLineRecord[];
}> {
  const receiptWeights = computeReceiptWeights(
    ALLOCATION_ALGO_REF,
    params.receipts,
    WEIGHT_CONFIG
  );
  const claimantAllocations = explodeToClaimants(
    receiptWeights,
    params.claimants
  );
  const finalAllocationSetHash =
    await computeFinalClaimantAllocationSetHash(claimantAllocations);
  const statementLines = computeAttributionStatementLines(
    claimantAllocations,
    params.poolCredits
  );

  return {
    finalAllocationSetHash,
    statementLines: statementLines.map((line) => ({
      claimant_key: line.claimantKey,
      claimant: line.claimant,
      final_units: line.finalUnits.toString(),
      pool_share: line.poolShare,
      credit_amount: line.creditAmount.toString(),
      receipt_ids: [...line.receiptIds],
    })),
  };
}

async function buildEchoEvaluation(
  epochId: bigint,
  events: readonly EventDef[]
): Promise<UpsertEvaluationParams> {
  const byEventType: Record<string, number> = {};
  const byUserId: Record<string, number> = {};
  for (const event of events) {
    byEventType[`${event.source}:${event.eventType}`] =
      (byEventType[`${event.source}:${event.eventType}`] ?? 0) + 1;
    if (event.contributor.userId) {
      byUserId[event.contributor.userId] =
        (byUserId[event.contributor.userId] ?? 0) + 1;
    }
  }
  const payloadJson: Record<string, unknown> = {
    totalEvents: events.length,
    byEventType,
    byUserId,
  };
  const canonical = JSON.stringify(
    payloadJson,
    Object.keys(payloadJson).sort()
  );
  const evalPayloadHash = sha256(canonical);
  const inputsHash = await computeEnricherInputsHash({
    epochId,
    receipts: events.map((e) => ({
      receiptId: e.id,
      receiptPayloadHash: eventPayloadHash(e),
    })),
  });
  return {
    nodeId: NODE_ID,
    epochId,
    evaluationRef: ECHO_EVALUATION_REF,
    status: "locked" as const,
    algoRef: ECHO_ALGO_REF,
    inputsHash,
    payloadHash: evalPayloadHash,
    payloadJson,
  };
}

async function seedLinkedUsersAndBindings(
  db: ReturnType<typeof createServiceDbClient>
): Promise<void> {
  await db
    .insert(users)
    .values(
      LINKED_CONTRIBUTORS.map((contributor) => ({
        id: contributor.userId as string,
        name: contributor.name,
      }))
    )
    .onConflictDoNothing();

  for (const contributor of LINKED_CONTRIBUTORS) {
    await db.transaction(async (tx) => {
      const [binding] = await tx
        .insert(userBindings)
        .values({
          id: `seed:github-binding:${contributor.platformUserId}`,
          userId: contributor.userId as string,
          provider: "github",
          externalId: contributor.platformUserId,
          providerLogin: contributor.login,
        })
        .onConflictDoNothing({
          target: [userBindings.provider, userBindings.externalId],
        })
        .returning({ id: userBindings.id });

      if (!binding) return;

      await tx.insert(identityEvents).values({
        id: `seed:identity-event:github:${contributor.platformUserId}`,
        userId: contributor.userId as string,
        eventType: "bind",
        payload: {
          method: "dev-seed",
          provider: "github",
          external_id: contributor.platformUserId,
          provider_login: contributor.login,
          repo: REPO_REF,
        },
      });
    });
  }
}

// ── Governance AI Activity ───────────────────────────────────────

const SYSTEM_USER_ID = "00000000-0000-4000-a000-000000000001";
const SYSTEM_BILLING_ACCOUNT_ID = "00000000-0000-4000-b000-000000000000";
const GOVERNANCE_GRAPH_ID = "sandbox:openclaw";
const GOVERNANCE_MODEL = "kimi-k2.5";

/** Heartbeat: ~3-8s, 800-2000 tokens in, 200-600 out, $0.001-0.005 */
interface RunProfile {
  graphId: string;
  model: string;
  provider: string;
  /** Billing source system. "litellm" for platform, "codex"/"ollama" for BYO. */
  sourceSystem: "litellm" | "codex" | "ollama";
  minLatencyMs: number;
  maxLatencyMs: number;
  minTokensIn: number;
  maxTokensIn: number;
  minTokensOut: number;
  maxTokensOut: number;
  /** Cost per 1K input tokens. 0 for BYO providers (zero platform cost). */
  costPerKTokenIn: number;
  /** Cost per 1K output tokens. 0 for BYO providers (zero platform cost). */
  costPerKTokenOut: number;
  /** Fraction of runs that fail (0.0-1.0) */
  errorRate: number;
}

const HEARTBEAT_PROFILE: RunProfile = {
  graphId: GOVERNANCE_GRAPH_ID,
  model: GOVERNANCE_MODEL,
  provider: "openrouter",
  sourceSystem: "litellm",
  minLatencyMs: 3000,
  maxLatencyMs: 8000,
  minTokensIn: 800,
  maxTokensIn: 2000,
  minTokensOut: 200,
  maxTokensOut: 600,
  costPerKTokenIn: 0.002,
  costPerKTokenOut: 0.006,
  errorRate: 0.05,
};

const LEDGER_INGEST_PROFILE: RunProfile = {
  graphId: GOVERNANCE_GRAPH_ID,
  model: GOVERNANCE_MODEL,
  provider: "openrouter",
  sourceSystem: "litellm",
  minLatencyMs: 8000,
  maxLatencyMs: 25000,
  minTokensIn: 2000,
  maxTokensIn: 6000,
  minTokensOut: 400,
  maxTokensOut: 1500,
  costPerKTokenIn: 0.002,
  costPerKTokenOut: 0.006,
  errorRate: 0.08,
};

// ── User AI Activity Profiles ──────────────────────────────────

const USER_AGENT_PROFILES: RunProfile[] = [
  // ── Platform (LiteLLM → OpenRouter) ──
  {
    graphId: "langgraph:poet",
    model: "claude-sonnet-4-20250514",
    provider: "anthropic",
    sourceSystem: "litellm",
    minLatencyMs: 4000,
    maxLatencyMs: 15000,
    minTokensIn: 1500,
    maxTokensIn: 8000,
    minTokensOut: 500,
    maxTokensOut: 3000,
    costPerKTokenIn: 0.003,
    costPerKTokenOut: 0.015,
    errorRate: 0.03,
  },
  {
    graphId: "langgraph:ponderer",
    model: "claude-sonnet-4-20250514",
    provider: "anthropic",
    sourceSystem: "litellm",
    minLatencyMs: 6000,
    maxLatencyMs: 30000,
    minTokensIn: 3000,
    maxTokensIn: 12000,
    minTokensOut: 1000,
    maxTokensOut: 5000,
    costPerKTokenIn: 0.003,
    costPerKTokenOut: 0.015,
    errorRate: 0.05,
  },
  {
    graphId: "codex:poet",
    model: "gpt-4o-mini",
    provider: "openai",
    sourceSystem: "litellm",
    minLatencyMs: 2000,
    maxLatencyMs: 8000,
    minTokensIn: 800,
    maxTokensIn: 4000,
    minTokensOut: 300,
    maxTokensOut: 1500,
    costPerKTokenIn: 0.00015,
    costPerKTokenOut: 0.0006,
    errorRate: 0.02,
  },
  {
    graphId: "codex:spark",
    model: "gpt-4o-mini",
    provider: "openai",
    sourceSystem: "litellm",
    minLatencyMs: 1500,
    maxLatencyMs: 6000,
    minTokensIn: 500,
    maxTokensIn: 3000,
    minTokensOut: 200,
    maxTokensOut: 1200,
    costPerKTokenIn: 0.00015,
    costPerKTokenOut: 0.0006,
    errorRate: 0.04,
  },
  // ── BYO: ChatGPT subscription via Codex SDK ──
  {
    graphId: "langgraph:poet",
    model: "gpt-5.4",
    provider: "openai-chatgpt",
    sourceSystem: "codex",
    minLatencyMs: 3000,
    maxLatencyMs: 12000,
    minTokensIn: 1000,
    maxTokensIn: 6000,
    minTokensOut: 400,
    maxTokensOut: 2500,
    costPerKTokenIn: 0, // Zero platform cost — user's subscription
    costPerKTokenOut: 0,
    errorRate: 0.05,
  },
  {
    graphId: "langgraph:ponderer",
    model: "gpt-5.3-codex",
    provider: "openai-chatgpt",
    sourceSystem: "codex",
    minLatencyMs: 2000,
    maxLatencyMs: 8000,
    minTokensIn: 800,
    maxTokensIn: 4000,
    minTokensOut: 300,
    maxTokensOut: 1500,
    costPerKTokenIn: 0,
    costPerKTokenOut: 0,
    errorRate: 0.04,
  },
  // ── BYO: Local LLM via OpenAI-compatible endpoint (Ollama) ──
  {
    graphId: "langgraph:poet",
    model: "llama3.1:8b",
    provider: "ollama",
    sourceSystem: "ollama",
    minLatencyMs: 1000,
    maxLatencyMs: 5000,
    minTokensIn: 500,
    maxTokensIn: 3000,
    minTokensOut: 200,
    maxTokensOut: 1500,
    costPerKTokenIn: 0, // Zero platform cost — user's hardware
    costPerKTokenOut: 0,
    errorRate: 0.08,
  },
  {
    graphId: "langgraph:ponderer",
    model: "deepseek-r1:14b",
    provider: "ollama",
    sourceSystem: "ollama",
    minLatencyMs: 2000,
    maxLatencyMs: 10000,
    minTokensIn: 1000,
    maxTokensIn: 5000,
    minTokensOut: 500,
    maxTokensOut: 3000,
    costPerKTokenIn: 0, // Zero platform cost — user's hardware
    costPerKTokenOut: 0,
    errorRate: 0.06,
  },
];

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

interface SeedChargeReceipt {
  receipt: typeof chargeReceipts.$inferInsert;
  detail: Omit<typeof llmChargeDetails.$inferInsert, "chargeReceiptId">;
}

function generateScheduledRuns(params: {
  scheduleId: string;
  cron: string;
  profile: RunProfile;
  startDate: Date;
  endDate: Date;
  temporalScheduleId: string;
  virtualKeyId: string;
}): {
  runs: (typeof graphRuns.$inferInsert)[];
  charges: SeedChargeReceipt[];
} {
  const runs: (typeof graphRuns.$inferInsert)[] = [];
  const charges: SeedChargeReceipt[] = [];

  // Parse simple cron: "0 * * * *" (hourly) or "0 6 * * *" (daily at 6)
  const cronParts = params.cron.split(" ");
  const cronMinute = Number.parseInt(cronParts[0] ?? "0", 10);
  const cronHour =
    cronParts[1] === "*" ? null : Number.parseInt(cronParts[1] ?? "0", 10);

  const cursor = new Date(params.startDate);
  // Align to first slot
  cursor.setUTCMinutes(cronMinute, 0, 0);
  if (cronHour !== null) {
    cursor.setUTCHours(cronHour);
    if (cursor < params.startDate) cursor.setUTCDate(cursor.getUTCDate() + 1);
  } else {
    if (cursor < params.startDate) cursor.setUTCHours(cursor.getUTCHours() + 1);
  }

  while (cursor <= params.endDate) {
    const scheduledFor = new Date(cursor);
    const runId = randomUUID();
    const isError = Math.random() < params.profile.errorRate;
    const latencyMs = randInt(
      params.profile.minLatencyMs,
      params.profile.maxLatencyMs
    );
    const startedAt = new Date(scheduledFor.getTime() + randInt(500, 3000));
    const completedAt = new Date(startedAt.getTime() + latencyMs);

    runs.push({
      scheduleId: params.scheduleId,
      runId,
      graphId: params.profile.graphId,
      runKind: "system_scheduled",
      triggerSource: "temporal_schedule",
      triggerRef: params.temporalScheduleId,
      requestedBy: SYSTEM_USER_ID,
      scheduledFor,
      startedAt,
      completedAt,
      status: isError ? "error" : "success",
      attemptCount: 1,
      errorCode: isError ? "provider_5xx" : null,
      errorMessage: isError
        ? "Upstream provider returned 502 Bad Gateway"
        : null,
      stateKey: null,
    });

    // One charge receipt per successful run (governance runs are single-turn)
    if (!isError) {
      const tokensIn = randInt(
        params.profile.minTokensIn,
        params.profile.maxTokensIn
      );
      const tokensOut = randInt(
        params.profile.minTokensOut,
        params.profile.maxTokensOut
      );
      const costUsd =
        (tokensIn / 1000) * params.profile.costPerKTokenIn +
        (tokensOut / 1000) * params.profile.costPerKTokenOut;
      const chargedCredits = BigInt(Math.ceil(costUsd * 1_000_000));

      const isByo = params.profile.sourceSystem !== "litellm";
      const usageUnitId = isByo ? `${runId}/0/byo` : randomUUID();

      charges.push({
        receipt: {
          billingAccountId: SYSTEM_BILLING_ACCOUNT_ID,
          virtualKeyId: params.virtualKeyId,
          runId,
          attempt: 0,
          ingressRequestId: runId,
          litellmCallId: isByo ? null : usageUnitId,
          chargedCredits,
          responseCostUsd: costUsd.toFixed(6),
          provenance: "response",
          chargeReason: "llm_usage",
          sourceSystem: params.profile.sourceSystem,
          sourceReference: `${runId}/0/${usageUnitId}`,
          receiptKind: "llm",
          createdAt: completedAt,
        },
        detail: {
          providerCallId: isByo ? null : usageUnitId,
          model: params.profile.model,
          provider: params.profile.provider,
          tokensIn,
          tokensOut,
          latencyMs,
          graphId: params.profile.graphId,
        },
      });
    }

    // Advance cursor
    if (cronHour !== null) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    } else {
      cursor.setUTCHours(cursor.getUTCHours() + 1);
    }
  }

  return { runs, charges };
}

async function seedGovernanceActivity(
  db: ReturnType<typeof createServiceDbClient>
): Promise<void> {
  // Reuse existing governance schedules (created by governance:schedules:sync)
  // or create them if they don't exist yet.
  const existingSchedules = await db
    .select({
      id: schedules.id,
      temporalScheduleId: schedules.temporalScheduleId,
    })
    .from(schedules)
    .where(eq(schedules.ownerUserId, SYSTEM_USER_ID));

  let heartbeatScheduleId = existingSchedules.find(
    (s) => s.temporalScheduleId === "governance:heartbeat"
  )?.id;
  let ledgerScheduleId = existingSchedules.find(
    (s) => s.temporalScheduleId === "governance:ledger_ingest"
  )?.id;

  if (!heartbeatScheduleId || !ledgerScheduleId) {
    // Create execution grant + schedules from scratch
    const grantId = randomUUID();
    await db.insert(executionGrants).values({
      id: grantId,
      userId: SYSTEM_USER_ID,
      billingAccountId: SYSTEM_BILLING_ACCOUNT_ID,
      scopes: ["graph:execute:sandbox:openclaw"],
    });

    if (!heartbeatScheduleId) {
      heartbeatScheduleId = randomUUID();
      await db.insert(schedules).values({
        id: heartbeatScheduleId,
        ownerUserId: SYSTEM_USER_ID,
        executionGrantId: grantId,
        graphId: GOVERNANCE_GRAPH_ID,
        input: { message: "HEARTBEAT", model: GOVERNANCE_MODEL },
        cron: "0 * * * *",
        timezone: "UTC",
        temporalScheduleId: "governance:heartbeat",
        enabled: true,
      });
    }

    if (!ledgerScheduleId) {
      ledgerScheduleId = randomUUID();
      await db.insert(schedules).values({
        id: ledgerScheduleId,
        ownerUserId: SYSTEM_USER_ID,
        executionGrantId: grantId,
        graphId: GOVERNANCE_GRAPH_ID,
        input: {
          message: "LEDGER_INGEST",
          model: GOVERNANCE_MODEL,
          version: 1,
          scopeId: SCOPE_ID,
          scopeKey: "default",
          epochLengthDays: 7,
        },
        cron: "0 6 * * *",
        timezone: "UTC",
        temporalScheduleId: "governance:ledger_ingest",
        enabled: true,
      });
    }
  }

  // Look up system tenant virtual key for charge_receipts FK
  const [systemVk] = await db
    .select({ id: virtualKeys.id })
    .from(virtualKeys)
    .where(eq(virtualKeys.billingAccountId, SYSTEM_BILLING_ACCOUNT_ID))
    .limit(1);
  if (!systemVk) {
    console.log("⚠️  No virtual key for system tenant. Skipping activity seed.");
    return;
  }

  // Generate 4 weeks of runs
  const seedStart = new Date(Date.now() - 28 * 86_400_000);
  const seedEnd = new Date();

  const heartbeatData = generateScheduledRuns({
    scheduleId: heartbeatScheduleId,
    cron: "0 * * * *",
    profile: HEARTBEAT_PROFILE,
    startDate: seedStart,
    endDate: seedEnd,
    temporalScheduleId: "governance:heartbeat",
    virtualKeyId: systemVk.id,
  });

  const ledgerData = generateScheduledRuns({
    scheduleId: ledgerScheduleId,
    cron: "0 6 * * *",
    profile: LEDGER_INGEST_PROFILE,
    startDate: seedStart,
    endDate: seedEnd,
    temporalScheduleId: "governance:ledger_ingest",
    virtualKeyId: systemVk.id,
  });

  const allRuns = [...heartbeatData.runs, ...ledgerData.runs];
  const allCharges = [...heartbeatData.charges, ...ledgerData.charges];

  // Insert runs — skip slots already occupied by real Temporal runs
  const BATCH_SIZE = 100;
  let insertedRuns = 0;
  for (let i = 0; i < allRuns.length; i += BATCH_SIZE) {
    const result = await db
      .insert(graphRuns)
      .values(allRuns.slice(i, i + BATCH_SIZE))
      .onConflictDoNothing()
      .returning({ id: graphRuns.id });
    insertedRuns += result.length;
  }

  // Insert charge_receipts for ALL successful system runs (seeded + real)
  // that don't already have a charge receipt. This fills in billing data for
  // real Temporal runs where the billing pipeline didn't capture costs.
  const allSuccessRuns = await db
    .select({
      runId: graphRuns.runId,
      completedAt: graphRuns.completedAt,
      graphId: graphRuns.graphId,
    })
    .from(graphRuns)
    .where(
      and(
        eq(graphRuns.runKind, "system_scheduled"),
        eq(graphRuns.status, "success")
      )
    );

  const existingChargeRunIds = new Set(
    (
      await db
        .select({ runId: chargeReceipts.runId })
        .from(chargeReceipts)
        .where(eq(chargeReceipts.billingAccountId, SYSTEM_BILLING_ACCOUNT_ID))
    ).map((r) => r.runId)
  );

  // Merge seed-generated charges with synthetic charges for real runs missing billing
  const chargesByRunId = new Map(allCharges.map((c) => [c.receipt.runId, c]));
  const chargesToInsert: SeedChargeReceipt[] = [];

  for (const run of allSuccessRuns) {
    if (existingChargeRunIds.has(run.runId)) continue;

    const seedCharge = chargesByRunId.get(run.runId);
    if (seedCharge) {
      chargesToInsert.push(seedCharge);
    } else {
      // Real run without billing data — synthesize a charge
      const profile =
        run.graphId === GOVERNANCE_GRAPH_ID
          ? HEARTBEAT_PROFILE
          : HEARTBEAT_PROFILE;
      const tokensIn = randInt(profile.minTokensIn, profile.maxTokensIn);
      const tokensOut = randInt(profile.minTokensOut, profile.maxTokensOut);
      const costUsd =
        (tokensIn / 1000) * profile.costPerKTokenIn +
        (tokensOut / 1000) * profile.costPerKTokenOut;
      const chargedCredits = BigInt(Math.ceil(costUsd * 1_000_000));

      chargesToInsert.push({
        receipt: {
          billingAccountId: SYSTEM_BILLING_ACCOUNT_ID,
          virtualKeyId: systemVk.id,
          runId: run.runId,
          attempt: 0,
          ingressRequestId: run.runId,
          litellmCallId: randomUUID(),
          chargedCredits,
          responseCostUsd: costUsd.toFixed(6),
          provenance: "response",
          chargeReason: "llm_usage",
          sourceSystem: "litellm",
          sourceReference: `${run.runId}/0/${randomUUID()}`,
          receiptKind: "llm",
          createdAt: run.completedAt ?? new Date(),
        },
        detail: {
          providerCallId: randomUUID(),
          model: profile.model,
          provider: profile.provider,
          tokensIn,
          tokensOut,
          latencyMs: randInt(profile.minLatencyMs, profile.maxLatencyMs),
          graphId: run.graphId ?? GOVERNANCE_GRAPH_ID,
        },
      });
    }
  }

  let insertedCharges = 0;
  for (const charge of chargesToInsert) {
    const [inserted] = await db
      .insert(chargeReceipts)
      .values(charge.receipt)
      .onConflictDoNothing()
      .returning({ id: chargeReceipts.id });
    if (inserted) {
      await db.insert(llmChargeDetails).values({
        chargeReceiptId: inserted.id,
        ...charge.detail,
      });
      insertedCharges++;
    }
  }

  // Update schedule last_run_at
  const lastHeartbeat = heartbeatData.runs.at(-1);
  const lastLedger = ledgerData.runs.at(-1);

  if (lastHeartbeat?.scheduledFor) {
    await db
      .update(schedules)
      .set({ lastRunAt: lastHeartbeat.scheduledFor })
      .where(eq(schedules.id, heartbeatScheduleId));
  }
  if (lastLedger?.scheduledFor) {
    await db
      .update(schedules)
      .set({ lastRunAt: lastLedger.scheduledFor })
      .where(eq(schedules.id, ledgerScheduleId));
  }

  const totalCost = chargesToInsert.reduce(
    (sum, c) => sum + Number.parseFloat(c.receipt.responseCostUsd as string),
    0
  );
  const skipped = allRuns.length - insertedRuns;

  console.log(
    `  Schedules: HEARTBEAT (${heartbeatScheduleId}), LEDGER_INGEST (${ledgerScheduleId})`
  );
  console.log(
    `  Graph runs: ${insertedRuns} inserted (${skipped} skipped — slots filled by real runs)`
  );
  console.log(
    `  Charge receipts: ${insertedCharges} (total seed cost: $${totalCost.toFixed(4)})`
  );
}

async function seedUserActivity(
  db: ReturnType<typeof createServiceDbClient>
): Promise<void> {
  // Find user accounts (non-system users with billing accounts)
  const userAccounts = await db
    .select({
      userId: billingAccounts.ownerUserId,
      billingAccountId: billingAccounts.id,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.isSystemTenant, false));

  if (userAccounts.length === 0) {
    console.log(
      "⚠️  No user billing accounts found. Skipping user activity seed."
    );
    return;
  }

  // Check for existing seeded user runs (look for our seed marker in triggerRef)
  const existingSeedRuns = await db
    .select({ id: graphRuns.id })
    .from(graphRuns)
    .where(eq(graphRuns.triggerSource, "dev-seed"))
    .limit(1);

  if (existingSeedRuns.length > 0) {
    console.log("⚠️  Existing user activity seed found. Skipping.");
    return;
  }

  let totalRuns = 0;
  let totalCharges = 0;
  let totalCost = 0;

  for (const account of userAccounts) {
    // Get virtual key for this account
    const [vk] = await db
      .select({ id: virtualKeys.id })
      .from(virtualKeys)
      .where(eq(virtualKeys.billingAccountId, account.billingAccountId))
      .limit(1);
    if (!vk) continue;

    // Generate 2-6 runs per day over the last 14 days, spread across agents
    const runs: (typeof graphRuns.$inferInsert)[] = [];
    const charges: SeedChargeReceipt[] = [];
    const seedDays = 14;

    for (let daysAgo = seedDays; daysAgo >= 0; daysAgo--) {
      const dayBase = new Date(Date.now() - daysAgo * 86_400_000);
      const runsToday = randInt(2, 6);

      for (let r = 0; r < runsToday; r++) {
        const profile =
          USER_AGENT_PROFILES[randInt(0, USER_AGENT_PROFILES.length - 1)] ??
          USER_AGENT_PROFILES[0];
        const runId = randomUUID();
        const isError = Math.random() < profile.errorRate;
        const hourOffset = randInt(8, 22); // runs during waking hours
        const minuteOffset = randInt(0, 59);
        const startedAt = new Date(dayBase);
        startedAt.setUTCHours(hourOffset, minuteOffset, randInt(0, 59));
        const latencyMs = randInt(profile.minLatencyMs, profile.maxLatencyMs);
        const completedAt = new Date(startedAt.getTime() + latencyMs);

        runs.push({
          runId,
          graphId: profile.graphId,
          runKind: "user_immediate",
          triggerSource: "dev-seed",
          requestedBy: account.userId,
          startedAt,
          completedAt,
          status: isError ? "error" : "success",
          attemptCount: 1,
          errorCode: isError ? "provider_5xx" : null,
          errorMessage: isError ? "Upstream provider returned 502" : null,
          stateKey: `seed-${runId.slice(0, 8)}`,
        });

        if (!isError) {
          const tokensIn = randInt(profile.minTokensIn, profile.maxTokensIn);
          const tokensOut = randInt(profile.minTokensOut, profile.maxTokensOut);
          const costUsd =
            (tokensIn / 1000) * profile.costPerKTokenIn +
            (tokensOut / 1000) * profile.costPerKTokenOut;
          const chargedCredits = BigInt(Math.ceil(costUsd * 1_000_000));

          // DETERMINISTIC_BYO_USAGE_ID: platform uses litellmCallId,
          // BYO uses deterministic ${runId}/${attempt}/byo
          const isByo = profile.sourceSystem !== "litellm";
          const usageUnitId = isByo ? `${runId}/0/byo` : randomUUID();

          charges.push({
            receipt: {
              billingAccountId: account.billingAccountId,
              virtualKeyId: vk.id,
              runId,
              attempt: 0,
              ingressRequestId: runId,
              litellmCallId: isByo ? null : usageUnitId,
              chargedCredits,
              responseCostUsd: costUsd.toFixed(6),
              provenance: "response",
              chargeReason: "llm_usage",
              sourceSystem: profile.sourceSystem,
              sourceReference: `${runId}/0/${usageUnitId}`,
              receiptKind: "llm",
              createdAt: completedAt,
            },
            detail: {
              providerCallId: isByo ? null : usageUnitId,
              model: profile.model,
              provider: profile.provider,
              tokensIn,
              tokensOut,
              latencyMs,
              graphId: profile.graphId,
            },
          });
        }
      }
    }

    // Insert runs
    const BATCH_SIZE = 50;
    for (let i = 0; i < runs.length; i += BATCH_SIZE) {
      await db.insert(graphRuns).values(runs.slice(i, i + BATCH_SIZE));
    }

    // Insert charges one-by-one for the FK chain
    for (const charge of charges) {
      const [inserted] = await db
        .insert(chargeReceipts)
        .values(charge.receipt)
        .onConflictDoNothing()
        .returning({ id: chargeReceipts.id });
      if (inserted) {
        await db.insert(llmChargeDetails).values({
          chargeReceiptId: inserted.id,
          ...charge.detail,
        });
      }
    }

    const userCost = charges.reduce(
      (sum, c) => sum + Number.parseFloat(c.receipt.responseCostUsd as string),
      0
    );
    totalRuns += runs.length;
    totalCharges += charges.length;
    totalCost += userCost;

    console.log(
      `  User ${account.userId.slice(0, 8)}...: ${runs.length} runs, ${charges.length} charges ($${userCost.toFixed(4)})`
    );
  }

  console.log(
    `  Total: ${totalRuns} runs, ${totalCharges} charges ($${totalCost.toFixed(4)})`
  );
  const agentBreakdown = USER_AGENT_PROFILES.map((p) => p.graphId).join(", ");
  console.log(`  Agents: ${agentBreakdown}`);
}

// ── Main ────────────────────────────────────────────────────────

async function seedFinalizedEpoch(
  store: DrizzleAttributionAdapter,
  epochDef: SeedEpochDef
): Promise<void> {
  const epoch = await store.createEpoch({
    nodeId: NODE_ID,
    scopeId: SCOPE_ID,
    periodStart: epochDef.periodStart,
    periodEnd: epochDef.periodEnd,
    weightConfig: WEIGHT_CONFIG,
  });
  console.log(
    `  Created epoch ${epoch.id} (${epochDef.periodStart.toISOString().slice(0, 10)} -> ${epochDef.periodEnd.toISOString().slice(0, 10)})`
  );

  const attributionReceipts = buildAttributionReceipts(epochDef.events);

  await store.insertIngestionReceipts(
    epochDef.events.map((event, index) => ({
      receiptId: event.id,
      nodeId: NODE_ID,
      source: event.source,
      eventType: event.eventType,
      platformUserId: event.contributor.platformUserId,
      platformLogin: event.contributor.login,
      artifactUrl: event.artifactUrl,
      metadata: {
        title: event.title,
        ...event.metadata,
      },
      payloadHash:
        attributionReceipts[index]?.payloadHash ?? eventPayloadHash(event),
      producer: PRODUCER,
      producerVersion: PRODUCER_VERSION,
      eventTime: event.eventTime,
      retrievedAt: event.eventTime,
    }))
  );
  console.log(`  Inserted ${epochDef.events.length} ingestion receipts`);

  await store.insertSelectionDoNothing(
    attributionReceipts.map((receipt) => ({
      nodeId: NODE_ID,
      epochId: epoch.id,
      receiptId: receipt.receiptId,
      userId: receipt.userId,
      included: true,
    }))
  );
  console.log(`  Inserted ${epochDef.events.length} selections`);

  const userProjections = computeUserProjections(
    attributionReceipts,
    WEIGHT_CONFIG
  );
  if (userProjections.length > 0) {
    await store.insertUserProjections(
      userProjections.map((projection) => ({
        nodeId: NODE_ID,
        epochId: epoch.id,
        userId: projection.userId,
        projectedUnits: projection.projectedUnits,
        receiptCount: projection.receiptCount,
      }))
    );
  }
  console.log(`  Inserted ${userProjections.length} resolved-user projections`);

  await store.insertPoolComponent({
    nodeId: NODE_ID,
    epochId: epoch.id,
    componentId: "base_issuance",
    algorithmVersion: "v1.0.0",
    inputsJson: { base_amount: Number(epochDef.poolCredits) },
    amountCredits: epochDef.poolCredits,
  });
  console.log("  Inserted pool component");

  // Insert receipt claimants (draft then lock)
  const claimantParams = buildReceiptClaimantParams(epoch.id, epochDef.events);
  for (const params of claimantParams) {
    await store.upsertDraftClaimants(params);
  }
  const lockedCount = await store.lockClaimantsForEpoch(epoch.id);
  console.log(`  Inserted ${lockedCount} locked receipt claimants`);

  const weightConfigHash = await computeWeightConfigHash(WEIGHT_CONFIG);
  const echoEval = await buildEchoEvaluation(epoch.id, epochDef.events);
  const evaluations = [echoEval];
  const artifactsHash = await computeArtifactsHash(evaluations);

  await store.closeIngestionWithEvaluations({
    epochId: epoch.id,
    approvers: SEED_APPROVERS,
    approverSetHash: await computeApproverSetHash(SEED_APPROVERS),
    allocationAlgoRef: ALLOCATION_ALGO_REF,
    weightConfigHash,
    evaluations,
    artifactsHash,
  });
  console.log("  Closed ingestion (open -> review)");

  await store.finalizeEpoch(epoch.id, epochDef.poolCredits);
  console.log("  Finalized epoch (review -> finalized)");

  // Load the locked claimants back for statement generation
  const lockedClaimants = await store.loadLockedClaimants(epoch.id);
  const statement = await buildClaimantAwareStatement({
    receipts: attributionReceipts,
    claimants: lockedClaimants,
    poolCredits: epochDef.poolCredits,
  });
  await store.insertEpochStatement({
    nodeId: NODE_ID,
    epochId: epoch.id,
    finalAllocationSetHash: statement.finalAllocationSetHash,
    poolTotalCredits: epochDef.poolCredits,
    statementLines: statement.statementLines,
  });
  console.log("  Inserted claimant-aware epoch statement");
}

async function seedReviewEpoch(
  store: DrizzleAttributionAdapter,
  epochDef: SeedEpochDef
): Promise<void> {
  const epoch = await store.createEpoch({
    nodeId: NODE_ID,
    scopeId: SCOPE_ID,
    periodStart: epochDef.periodStart,
    periodEnd: epochDef.periodEnd,
    weightConfig: WEIGHT_CONFIG,
  });
  console.log(
    `  Created epoch ${epoch.id} (${epochDef.periodStart.toISOString().slice(0, 10)} -> ${epochDef.periodEnd.toISOString().slice(0, 10)}) [REVIEW]`
  );

  const attributionReceipts = buildAttributionReceipts(epochDef.events);

  await store.insertIngestionReceipts(
    epochDef.events.map((event, index) => ({
      receiptId: event.id,
      nodeId: NODE_ID,
      source: event.source,
      eventType: event.eventType,
      platformUserId: event.contributor.platformUserId,
      platformLogin: event.contributor.login,
      artifactUrl: event.artifactUrl,
      metadata: {
        title: event.title,
        ...event.metadata,
      },
      payloadHash:
        attributionReceipts[index]?.payloadHash ?? eventPayloadHash(event),
      producer: PRODUCER,
      producerVersion: PRODUCER_VERSION,
      eventTime: event.eventTime,
      retrievedAt: event.eventTime,
    }))
  );
  console.log(`  Inserted ${epochDef.events.length} ingestion receipts`);

  await store.insertSelectionDoNothing(
    attributionReceipts.map((receipt) => ({
      nodeId: NODE_ID,
      epochId: epoch.id,
      receiptId: receipt.receiptId,
      userId: receipt.userId,
      included: true,
    }))
  );
  console.log(`  Inserted ${epochDef.events.length} selections`);

  const userProjections = computeUserProjections(
    attributionReceipts,
    WEIGHT_CONFIG
  );
  if (userProjections.length > 0) {
    await store.insertUserProjections(
      userProjections.map((projection) => ({
        nodeId: NODE_ID,
        epochId: epoch.id,
        userId: projection.userId,
        projectedUnits: projection.projectedUnits,
        receiptCount: projection.receiptCount,
      }))
    );
  }
  console.log(`  Inserted ${userProjections.length} resolved-user projections`);

  await store.insertPoolComponent({
    nodeId: NODE_ID,
    epochId: epoch.id,
    componentId: "base_issuance",
    algorithmVersion: "v1.0.0",
    inputsJson: { base_amount: Number(epochDef.poolCredits) },
    amountCredits: epochDef.poolCredits,
  });
  console.log("  Inserted pool component");

  // Insert receipt claimants (draft then lock)
  const claimantParams = buildReceiptClaimantParams(epoch.id, epochDef.events);
  for (const params of claimantParams) {
    await store.upsertDraftClaimants(params);
  }
  const lockedCount = await store.lockClaimantsForEpoch(epoch.id);
  console.log(`  Inserted ${lockedCount} locked receipt claimants`);

  const weightConfigHash = await computeWeightConfigHash(WEIGHT_CONFIG);
  const echoEval = await buildEchoEvaluation(epoch.id, epochDef.events);
  const evaluations = [echoEval];
  const artifactsHash = await computeArtifactsHash(evaluations);

  await store.closeIngestionWithEvaluations({
    epochId: epoch.id,
    approvers: SEED_APPROVERS,
    approverSetHash: await computeApproverSetHash(SEED_APPROVERS),
    allocationAlgoRef: ALLOCATION_ALGO_REF,
    weightConfigHash,
    evaluations,
    artifactsHash,
  });
  console.log("  Closed ingestion (open -> review)");
}

async function seedOpenEpoch(
  store: DrizzleAttributionAdapter,
  epochDef: SeedEpochDef
): Promise<void> {
  const epoch = await store.createEpoch({
    nodeId: NODE_ID,
    scopeId: SCOPE_ID,
    periodStart: epochDef.periodStart,
    periodEnd: epochDef.periodEnd,
    weightConfig: WEIGHT_CONFIG,
  });
  console.log(
    `  Created epoch ${epoch.id} (${epochDef.periodStart.toISOString().slice(0, 10)} -> ${epochDef.periodEnd.toISOString().slice(0, 10)}) [OPEN]`
  );

  await store.insertIngestionReceipts(
    epochDef.events.map((event) => ({
      receiptId: event.id,
      nodeId: NODE_ID,
      source: event.source,
      eventType: event.eventType,
      platformUserId: event.contributor.platformUserId,
      platformLogin: event.contributor.login,
      artifactUrl: event.artifactUrl,
      metadata: {
        title: event.title,
        ...event.metadata,
      },
      payloadHash: eventPayloadHash(event),
      producer: PRODUCER,
      producerVersion: PRODUCER_VERSION,
      eventTime: event.eventTime,
      retrievedAt: event.eventTime,
    }))
  );
  console.log(`  Inserted ${epochDef.events.length} ingestion receipts`);
  console.log(
    "  Selections, projections, and claimants will be created by the pipeline when triggered"
  );
}

/**
 * Prod-safety: this seed writes FABRICATED attribution data (fake contributors,
 * epochs, receipts) that on a real ledger would drive token distribution to real
 * people. It is a LOCAL-DEV tool ONLY.
 *
 * It refuses any non-local database with NO escape hatch — deliberately no env
 * override, no ack flag, no allowlist. That absence is the point: there is no
 * code path anywhere that can point this seed at a deployed ledger (candidate-a,
 * preview, prod), so no laptop, CI job, or future agent can misuse it. Seeding a
 * deployed test node for validation is a rare, human-driven act done by hand over
 * SSH — never encoded here.
 *
 * (In-cluster execution sees the DB as `postgres`/localhost, so a human on the VM
 * can still run it manually; the guard blocks the remote/automated vector — a
 * deployed DB URL supplied from outside.)
 */
function assertLocalDbOnly(dbUrl: string): void {
  let host = "";
  try {
    host = new URL(dbUrl).hostname;
  } catch {
    throw new Error("REFUSING TO SEED: unparseable DATABASE_SERVICE_URL host");
  }
  const isLocal = ["localhost", "127.0.0.1", "::1", "postgres"].includes(host);
  if (!isLocal) {
    throw new Error(
      `REFUSING TO SEED: host '${host}' is not local. This seed is a LOCAL-DEV ` +
        "tool only and never runs against a deployed ledger — there is no " +
        "override by design. Seed a deployed test node manually over SSH."
    );
  }
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_SERVICE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_SERVICE_URL not set in .env.local");
  }

  assertLocalDbOnly(dbUrl);

  console.log("🌱 Dev Seed: Claimant-Aware Attribution Data");
  console.log(`   Node: ${NODE_ID}`);
  console.log(`   Scope: ${SCOPE_ID}`);
  console.log(`   Repo: ${REPO_REF}`);
  console.log(`   Database: ${dbUrl.replace(/\/\/[^@]+@/, "//***@")}`);
  console.log();

  const db = createServiceDbClient(dbUrl);
  const store = new DrizzleAttributionAdapter(db, SCOPE_ID);

  try {
    const existingEpochs = await store.listEpochs(NODE_ID);
    if (existingEpochs.length > 0) {
      const openEpoch = existingEpochs.find((epoch) => epoch.status === "open");
      console.log(
        `⚠️  Existing attribution epochs found for node ${NODE_ID}. Skipping epoch seed.`
      );
      if (openEpoch) {
        console.log(
          `   Existing open epoch: ${openEpoch.id}. Finalize or delete it before reseeding.`
        );
      }
    } else {
      console.log("👤 Seeding linked contributor accounts...");
      await seedLinkedUsersAndBindings(db);
      console.log(
        `  Inserted ${LINKED_CONTRIBUTORS.length} linked users with GitHub bindings`
      );
      console.log(
        `  Unlinked GitHub identities remain receipt-only: ${DEREK.login}, ${COGNI.login}, ${MIRA.login}`
      );
      console.log();

      console.log("📦 Epoch 1 (finalized):");
      await seedFinalizedEpoch(store, EPOCH_1);
      console.log();

      console.log("📦 Epoch 2 (finalized):");
      await seedFinalizedEpoch(store, EPOCH_2);
      console.log();

      console.log("📦 Epoch 3 (review):");
      await seedReviewEpoch(store, EPOCH_3);
      console.log();

      console.log("📦 Epoch 4 (open):");
      await seedOpenEpoch(store, EPOCH_4);
      console.log();
    }

    console.log("🤖 Governance AI activity (4 weeks):");
    await seedGovernanceActivity(db);
    console.log();

    console.log("👤 User AI activity (2 weeks, 4 agents):");
    await seedUserActivity(db);
    console.log();

    console.log(
      "✅ Dev seed complete! Start the dev server with `pnpm dev` and visit:"
    );
    console.log(
      "   /gov/epoch    -> current open epoch with resolved contributors + unresolved GitHub identities"
    );
    console.log(
      "   /gov/history  -> finalized epochs with claimant-aware statements"
    );
    console.log(
      "   /gov/holdings -> cumulative holdings including unresolved claimant sets"
    );
    console.log(
      "   /gov/review   -> epoch in review status ready for sign & finalize workflow"
    );
    console.log(
      "   /profile      -> derekg1729 stays unlinked (link via OAuth); Alice + Ben are pre-linked; Cogni + Mira unclaimed"
    );
  } finally {
    await db.$client.end();
  }
}

main().catch((error: Error) => {
  console.error("\n💥 Seed failed:");
  console.error(error.message);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
