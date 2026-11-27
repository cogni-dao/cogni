// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/node-code`
 * Purpose: Bind immutable code reads to this node, source repository and serving revision.
 * Scope: Existing App installation contents:read only; no local filesystem fallback or new grants. Does not perform source mutations.
 * Invariants: ToolRunner and this bound capability independently require computed node.flight authority; reject wrong execution node.
 *   REVIEW_READS_PR_HEAD (story.5102): when the run scope carries a host-validated `codeSubject`, every
 *   call builds a NEW reader for `codeSubject.owner/repo@headSha` with REVIEW_NODE_CODE_POLICY — the
 *   serving-code reader is never mutated.
 *   SUBJECT_MUST_BE_LISTED (task.5448): a subject for ANOTHER node is admitted only when that node is a listed
 *   service-link target (`.cogni/service-links.yaml`, one reader). `scope.nodeId` stays this node; the
 *   `node.flight` check runs on the SUBJECT node's resource, so the requesting developer needs flight authority
 *   there. Code is read through this node's GitHub App from the subject's catalog repo.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/subtask.5027, story.5102
 * @internal
 */

import type { NodeCodeCapability } from "@cogni/ai-tools";
import {
  type AuthorizationPort,
  type AuthzDecision,
  authzNodeResource,
} from "@cogni/authorization-core";
import {
  GitHubVcsAdapter,
  getExecutionScope,
  REVIEW_NODE_CODE_POLICY,
} from "@/adapters/server";
import { findServiceLinkTarget, type LinkTarget } from "@/shared/config";

/**
 * Read one UTF-8 file of a pinned commit through this node's GitHub App (host-owned, no model argument).
 * Returns null when the file is absent, unreadable or only partly returned. Used for the reviewed node's
 * repo-spec at the base SHA (task.5448); the review admission policy applies.
 */
export function createCommitFileReader(deps: {
  appId: string | undefined;
  privateKeyBase64: string | undefined;
  log: {
    info(fields: Record<string, unknown>): void;
    warn(fields: Record<string, unknown>): void;
  };
}): (input: {
  nodeId: string;
  origin: string;
  owner: string;
  repo: string;
  commitSha: string;
  path: string;
}) => Promise<string | null> {
  let adapter: GitHubVcsAdapter | undefined;
  return async (input) => {
    if (!deps.appId || !deps.privateKeyBase64) return null;
    adapter ??= new GitHubVcsAdapter({
      appId: deps.appId,
      privateKey: Buffer.from(deps.privateKeyBase64, "base64").toString("utf8"),
    });
    const result = await adapter
      .nodeCodeReader(
        {
          nodeId: input.nodeId,
          origin: input.origin,
          owner: input.owner,
          repo: input.repo,
          commitSha: input.commitSha,
          roots: [],
          manifests: [],
        },
        deps.log,
        REVIEW_NODE_CODE_POLICY
      )
      .read({ path: input.path });
    return result.fileComplete && result.content !== null
      ? result.content
      : null;
  };
}

export function createNodeCodeCapability(deps: {
  getAuthorization?: () => AuthorizationPort | undefined;
  /** The listed target for a node id; defaults to the service-links reader (tests inject). */
  findLinkTarget?: (nodeId: string) => LinkTarget | undefined;
  nodeId: string;
  origin: string | undefined;
  owner: string;
  repo: string;
  commitSha: string | undefined;
  appId: string | undefined;
  privateKeyBase64: string | undefined;
  log: {
    info(fields: Record<string, unknown>): void;
    warn(fields: Record<string, unknown>): void;
  };
}): NodeCodeCapability {
  let reader: NodeCodeCapability | undefined;
  let adapter: GitHubVcsAdapter | undefined;
  let origin: string | undefined;
  if (deps.origin) {
    try {
      const parsed = new URL(deps.origin);
      if (parsed.protocol === "https:" || parsed.protocol === "http:")
        origin = parsed.origin;
    } catch {
      /* Invalid optional source configuration remains unavailable. */
    }
  }
  if (origin && deps.appId && deps.privateKeyBase64) {
    adapter = new GitHubVcsAdapter({
      appId: deps.appId,
      privateKey: Buffer.from(deps.privateKeyBase64, "base64").toString("utf8"),
    });
  }
  if (
    adapter &&
    origin &&
    deps.commitSha &&
    /^[0-9a-f]{40}$/.test(deps.commitSha)
  ) {
    reader = adapter.nodeCodeReader(
      {
        nodeId: deps.nodeId,
        origin,
        owner: deps.owner,
        repo: deps.repo,
        commitSha: deps.commitSha,
        roots: [
          "packages",
          "nodes/operator/app/src",
          "nodes/operator/graphs",
          "docs/spec",
          "docs/guides",
          "tests",
        ],
        manifests: [
          "package.json",
          "pnpm-workspace.yaml",
          "tsconfig.json",
          "tsconfig.base.json",
          "biome.json",
        ],
      },
      deps.log
    );
  }
  async function scoped(): Promise<NodeCodeCapability> {
    const scope = getExecutionScope();
    if (!scope.principalId || scope.nodeId !== deps.nodeId)
      throw new Error("node_code_scope_unavailable");
    const subject = scope.codeSubject;
    // SUBJECT_MUST_BE_LISTED: another node's code is readable only when that node is a listed link target.
    const linked =
      subject && subject.nodeId !== deps.nodeId
        ? (deps.findLinkTarget ?? findServiceLinkTarget)(subject.nodeId)
        : undefined;
    if (subject && subject.nodeId !== deps.nodeId && !linked)
      throw new Error("node_code_authz_denied");
    const subjectOrigin = linked?.origin ?? origin;
    if (subject ? !adapter || !subjectOrigin : !reader)
      throw new Error("node_code_source_unavailable");
    const authorization = deps.getAuthorization?.();
    if (!authorization) throw new Error("node_code_authz_unavailable");
    // `scope.nodeId` stays this node; the flight authority is checked on the node whose code is read.
    const authzNodeId = subject?.nodeId ?? deps.nodeId;
    let decision: AuthzDecision;
    try {
      decision = await authorization.check({
        actorId: `agent:${scope.principalId}`,
        ...(scope.subjectUserId
          ? { subjectId: `user:${scope.subjectUserId}` }
          : {}),
        action: "node.flight",
        resource: authzNodeResource(authzNodeId),
        context: {
          nodeId: authzNodeId,
          tenantId: scope.billing.billingAccountId,
          ...(scope.grantId ? { grantId: scope.grantId } : {}),
        },
      });
    } catch {
      throw new Error("node_code_authz_unavailable");
    }
    if (decision.decision !== "allow")
      throw new Error(
        decision.code === "authz_unavailable"
          ? "node_code_authz_unavailable"
          : "node_code_authz_denied"
      );
    if (subject && adapter && subjectOrigin) {
      // A fresh reader per call, bound to the PR head; the serving reader stays untouched.
      return adapter.nodeCodeReader(
        {
          nodeId: subject.nodeId,
          origin: subjectOrigin,
          owner: subject.owner,
          repo: subject.repo,
          commitSha: subject.headSha,
          roots: [],
          manifests: [],
        },
        deps.log,
        REVIEW_NODE_CODE_POLICY
      );
    }
    if (!reader) throw new Error("node_code_source_unavailable");
    return reader;
  }
  return {
    read: async (input) => (await scoped()).read(input),
    list: async (input) => (await scoped()).list(input),
  };
}
