// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/service/contribution-service`
 * Purpose: Framework-agnostic typed handlers for the knowledge contribution flow.
 * Scope: Pure business logic — quotas, idempotency lookup, role gating, confidence cap. Does not contain HTTP, env, or lifecycle code; per-node `route.ts` files adapt these to Next.
 * Invariants: KNOWLEDGE_MERGE_REQUIRES_ADMIN_SESSION; CONTRIBUTION_OWNER_CAN_APPEND; CONTRIBUTION_OWNER_CAN_CLOSE.
 * Side-effects: none (delegates I/O to KnowledgeContributionPort)
 * Links: docs/design/knowledge-contribution-api.md
 * @public
 */

import type {
  ContributionCommitRecord,
  ContributionDiffEntry,
  ContributionRecord,
  ContributionState,
  KnowledgeContributionEdit,
  KnowledgeEntryInput,
  Principal,
} from "../domain/contribution-schemas.js";
import {
  type KnowledgeGate,
  KnowledgeGateError,
  runGateChain,
} from "../domain/gates/index.js";
import {
  ContributionForbiddenError,
  ContributionNotFoundError,
  ContributionQuotaError,
  ContributionStateError,
  type CreateEdoDecisionInput,
  type CreateEdoHypothesisInput,
  type CreateEdoOutcomeInput,
  type KnowledgeContributionPort,
} from "../port/contribution.port.js";

export interface CreateBody {
  message: string;
  edits?: KnowledgeContributionEdit[];
  idempotencyKey?: string;
}

export interface AppendCommitBody {
  message: string;
  edits: KnowledgeContributionEdit[];
}

/**
 * Body shape for the EDO atomic-batch service methods. Mirrors the existing
 * `CreateBody` shape (message + idempotencyKey) so handlers can use the same
 * routing/quota pattern; the entry/payload-specific fields come from the
 * route's Zod-validated request body.
 */
export type CreateEdoHypothesisBody = Omit<
  CreateEdoHypothesisInput,
  "principal"
>;
export type CreateEdoDecisionBody = Omit<CreateEdoDecisionInput, "principal">;
export type CreateEdoOutcomeBody = Omit<CreateEdoOutcomeInput, "principal">;

export interface ListQuery {
  state?: ContributionState | "all";
  principalId?: string;
  limit?: number;
}

export interface ContributionServiceDeps {
  port: KnowledgeContributionPort;
  canMergeKnowledge: (p: Principal) => boolean;
  rateLimit: { maxOpenPerPrincipal: number };
  /**
   * Write-pipeline gates run against every insert/update edit before it is
   * forwarded to the port. Throws `KnowledgeGateError` on failure; the HTTP
   * handler maps that to 400 with structured field-level issues.
   *
   * v0: shape gate only (provenance is stamped by the adapter for the
   * external-contribution path, so cross-field provenance enforcement lives
   * on the internal-write path instead).
   *
   * @default V0_CONTRIBUTION_EDIT_GATES (shape gate only)
   */
  gates?: readonly KnowledgeGate[];
  /**
   * Optional fire-and-forget hook invoked after a successful merge. Used by
   * the operator container to mirror the canonical knowledge branch to a
   * Dolt remote (typically DoltHub). The caller MUST own its own error
   * handling — this service deliberately does not await and does not catch.
   * Per task.5069 + docs/runbooks/dolthub-remote-bootstrap.md.
   */
  pushMainOnMerge?: () => Promise<void>;
}

export interface ContributionService {
  create(args: {
    principal: Principal;
    body: CreateBody;
  }): Promise<ContributionRecord>;
  /**
   * Open a contrib branch and apply a hypothesis atomic batch on it.
   * Mirrors `create()`: idempotency replay + open-quota check, then forwards
   * to the port's `createEdoHypothesis`. Used by the bearer-auth path of
   * `POST /api/v1/edo/hypothesize` to satisfy EDO_BEARER_VIA_CONTRIB_BRANCH.
   */
  createEdoHypothesisContribution(args: {
    principal: Principal;
    body: CreateEdoHypothesisBody;
  }): Promise<ContributionRecord>;
  /** Decision atomic batch on a fresh contrib branch. See `createEdoHypothesisContribution`. */
  createEdoDecisionContribution(args: {
    principal: Principal;
    body: CreateEdoDecisionBody;
  }): Promise<ContributionRecord>;
  /** Outcome atomic batch (+ hypothesis confidence recompute) on a fresh contrib branch. */
  createEdoOutcomeContribution(args: {
    principal: Principal;
    body: CreateEdoOutcomeBody;
  }): Promise<ContributionRecord>;
  appendCommit(args: {
    principal: Principal;
    contributionId: string;
    body: AppendCommitBody;
  }): Promise<ContributionCommitRecord>;
  list(args: {
    principal: Principal;
    query: ListQuery;
  }): Promise<ContributionRecord[]>;
  getById(contributionId: string): Promise<ContributionRecord | null>;
  listCommits(contributionId: string): Promise<ContributionCommitRecord[]>;
  diff(contributionId: string): Promise<ContributionDiffEntry[]>;
  merge(args: {
    principal: Principal;
    contributionId: string;
    confidencePct?: number;
  }): Promise<{ commitHash: string }>;
  close(args: {
    principal: Principal;
    contributionId: string;
    reason: string;
  }): Promise<void>;
}

export function createContributionService(
  deps: ContributionServiceDeps
): ContributionService {
  const gates = deps.gates ?? [];

  async function gateEdits(
    edits: KnowledgeContributionEdit[] | undefined
  ): Promise<KnowledgeContributionEdit[] | undefined> {
    if (!edits || edits.length === 0 || gates.length === 0) return edits;
    const out: KnowledgeContributionEdit[] = [];
    for (const edit of edits) {
      if (edit.op === "deprecate") {
        out.push(edit);
        continue;
      }
      const result = await runGateChain(gates, edit.entry, {});
      if (!result.ok) {
        throw new KnowledgeGateError(result.errors);
      }
      // runGateChain widens to KnowledgeWriteCandidate (which extends
      // KnowledgeEntryInput with optional source fields). Strip the
      // candidate-only fields before re-packing the edit.
      const sanitized: KnowledgeEntryInput = {
        ...edit.entry,
        ...result.candidate,
      };
      if (edit.op === "insert") {
        out.push({ op: "insert", entry: sanitized });
      } else {
        out.push({
          op: "update",
          targetRowId: edit.targetRowId,
          entry: sanitized,
        });
      }
    }
    return out;
  }

  async function idempotencyReplay(
    principal: Principal,
    idempotencyKey: string | undefined
  ): Promise<ContributionRecord | null> {
    if (!idempotencyKey) return null;
    const prior = await deps.port.list({
      state: "all",
      principalId: principal.id,
      limit: 100,
    });
    return prior.find((r) => r.idempotencyKey === idempotencyKey) ?? null;
  }

  async function enforceOpenQuota(principal: Principal): Promise<void> {
    const open = await deps.port.list({
      state: "open",
      principalId: principal.id,
      limit: 100,
    });
    if (open.length >= deps.rateLimit.maxOpenPerPrincipal) {
      throw new ContributionQuotaError(
        `max open contributions per principal = ${deps.rateLimit.maxOpenPerPrincipal}`
      );
    }
  }

  return {
    async create({ principal, body }) {
      const replayed = await idempotencyReplay(principal, body.idempotencyKey);
      if (replayed) return replayed;
      await enforceOpenQuota(principal);
      const gated = await gateEdits(body.edits);
      return deps.port.create({
        principal,
        message: body.message,
        edits: gated,
        idempotencyKey: body.idempotencyKey,
      });
    },

    async createEdoHypothesisContribution({ principal, body }) {
      const replayed = await idempotencyReplay(principal, body.idempotencyKey);
      if (replayed) return replayed;
      // COMPOUNDING_VIA_ONE_OPEN_CONTRIBUTION_PER_PRINCIPAL: if this principal
      // already has an open contribution, append the EDO batch onto its
      // branch so a hypothesize -> decide -> record-outcome chain compounds
      // into one reviewable unit instead of sprawling into N contributions.
      // Only when no open contribution exists do we enforce the open-quota
      // and create a new branch.
      const existing = await deps.port.findOpenForPrincipal(principal.id);
      if (existing) {
        return deps.port.appendEdoHypothesis({
          principal,
          contributionId: existing.contributionId,
          ...body,
        });
      }
      await enforceOpenQuota(principal);
      return deps.port.createEdoHypothesis({ principal, ...body });
    },

    async createEdoDecisionContribution({ principal, body }) {
      const replayed = await idempotencyReplay(principal, body.idempotencyKey);
      if (replayed) return replayed;
      const existing = await deps.port.findOpenForPrincipal(principal.id);
      if (existing) {
        return deps.port.appendEdoDecision({
          principal,
          contributionId: existing.contributionId,
          ...body,
        });
      }
      await enforceOpenQuota(principal);
      return deps.port.createEdoDecision({ principal, ...body });
    },

    async createEdoOutcomeContribution({ principal, body }) {
      const replayed = await idempotencyReplay(principal, body.idempotencyKey);
      if (replayed) return replayed;
      const existing = await deps.port.findOpenForPrincipal(principal.id);
      if (existing) {
        return deps.port.appendEdoOutcome({
          principal,
          contributionId: existing.contributionId,
          ...body,
        });
      }
      await enforceOpenQuota(principal);
      return deps.port.createEdoOutcome({ principal, ...body });
    },

    async appendCommit({ principal, contributionId, body }) {
      const record = await deps.port.getById(contributionId);
      if (!record) {
        throw new ContributionNotFoundError(contributionId);
      }
      if (record.state !== "open") {
        throw new ContributionStateError(
          `contribution ${contributionId} is ${record.state}`
        );
      }
      const ownsContribution =
        record.principalId === principal.id &&
        record.principalKind === principal.kind;
      if (!ownsContribution) {
        throw new ContributionForbiddenError(
          "append requires contribution owner"
        );
      }
      const gated = await gateEdits(body.edits);
      // gateEdits returns undefined only when input was undefined/empty; for
      // appendCommit the schema requires at least 1 edit, so non-null assert.
      return deps.port.appendCommit({
        contributionId,
        principal,
        message: body.message,
        edits: gated ?? body.edits,
      });
    },

    async list({ query }) {
      return deps.port.list({
        state: query.state ?? "open",
        principalId: query.principalId,
        limit: query.limit ?? 20,
      });
    },

    async getById(contributionId) {
      return deps.port.getById(contributionId);
    },

    async listCommits(contributionId) {
      return deps.port.listCommits(contributionId);
    },

    async diff(contributionId) {
      return deps.port.diff(contributionId);
    },

    async merge({ principal, contributionId, confidencePct }) {
      if (!deps.canMergeKnowledge(principal)) {
        throw new ContributionForbiddenError("merge requires admin session");
      }
      const result = await deps.port.merge({
        contributionId,
        principal,
        confidencePct,
      });
      // Best-effort mirror. Caller wraps with its own .catch — service stays
      // framework-agnostic and never blocks the merge response on the push.
      if (deps.pushMainOnMerge) {
        void deps.pushMainOnMerge();
      }
      return result;
    },

    async close({ principal, contributionId, reason }) {
      const record = await deps.port.getById(contributionId);
      if (!record) {
        throw new ContributionNotFoundError(contributionId);
      }
      const ownsContribution =
        record.principalId === principal.id &&
        record.principalKind === principal.kind;
      if (!ownsContribution && !deps.canMergeKnowledge(principal)) {
        throw new ContributionForbiddenError("close requires admin session");
      }
      return deps.port.close({ contributionId, principal, reason });
    },
  };
}

/**
 * v0 merge gate: any session-cookie user can merge.
 *
 * Per `KNOWLEDGE_LOOP_CLOSED_VIA_SIGNED_IN_USER` invariant: routes only mint a
 * `kind: 'user'` Principal when the request arrived on the cookie-session path.
 * Bearer-token agents resolve to `kind: 'agent'` and are rejected here. When
 * per-user RBAC lands, this becomes a real role check.
 */
export function defaultCanMergeKnowledge(p: Principal): boolean {
  return p.kind === "user";
}
