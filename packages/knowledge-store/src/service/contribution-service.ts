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
}

export interface ContributionService {
  create(args: {
    principal: Principal;
    body: CreateBody;
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

  return {
    async create({ principal, body }) {
      // Idempotency replay — return prior record if same (principal, key) exists.
      if (body.idempotencyKey) {
        const prior = await deps.port.list({
          state: "all",
          principalId: principal.id,
          limit: 100,
        });
        const hit = prior.find((r) => r.idempotencyKey === body.idempotencyKey);
        if (hit) return hit;
      }

      // Quota — N open contributions per principal.
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

      const gated = await gateEdits(body.edits);

      return deps.port.create({
        principal,
        message: body.message,
        edits: gated,
        idempotencyKey: body.idempotencyKey,
      });
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
      return deps.port.merge({ contributionId, principal, confidencePct });
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
