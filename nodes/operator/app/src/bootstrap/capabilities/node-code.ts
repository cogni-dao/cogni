// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/node-code`
 * Purpose: Bind immutable code reads to this node, source repository and serving revision.
 * Scope: Existing App installation contents:read only; no local filesystem fallback or new grants. Does not perform source mutations.
 * Invariants: ToolRunner and this bound capability independently require computed node.flight authority; reject wrong execution node.
 *   REVIEW_READS_PR_HEAD (story.5102): when the run scope carries a host-validated `codeSubject`, every
 *   call builds a NEW reader for `codeSubject.owner/repo@headSha` with REVIEW_NODE_CODE_POLICY — the
 *   serving-code reader is never mutated. LINKED_NODE_AUTHZ (story.0038): the `node.flight` check runs on the
 *   node the subject names (a developer of X holds it on X); a subject for another node needs its registered
 *   origin from `resolveSubjectOrigin`, else no source.
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

export function createNodeCodeCapability(deps: {
  getAuthorization?: () => AuthorizationPort | undefined;
  nodeId: string;
  origin: string | undefined;
  owner: string;
  repo: string;
  commitSha: string | undefined;
  appId: string | undefined;
  privateKeyBase64: string | undefined;
  /**
   * Registered origin of ANOTHER node a review subject may name (story.0038). Absent or null → a
   * subject for another node has no source (`node_code_source_unavailable`).
   */
  resolveSubjectOrigin?: (nodeId: string) => Promise<string | null>;
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
    if (!scope.actorUserId || scope.nodeId !== deps.nodeId)
      throw new Error("node_code_scope_unavailable");
    const subject = scope.codeSubject;
    // The node whose code is read: this node, or (story.0038) the linked node a review subject names.
    const subjectNodeId = subject?.nodeId ?? deps.nodeId;
    if (subject ? !adapter || !origin : !reader)
      throw new Error("node_code_source_unavailable");
    let subjectOrigin = origin;
    if (subject && subject.nodeId !== deps.nodeId) {
      let resolved: string | null = null;
      try {
        resolved = (await deps.resolveSubjectOrigin?.(subject.nodeId)) ?? null;
      } catch {
        resolved = null;
      }
      if (!resolved) throw new Error("node_code_source_unavailable");
      subjectOrigin = resolved;
    }
    const authorization = deps.getAuthorization?.();
    if (!authorization) throw new Error("node_code_authz_unavailable");
    let decision: AuthzDecision;
    try {
      decision = await authorization.check({
        actorId: `user:${scope.actorUserId}`,
        action: "node.flight",
        resource: authzNodeResource(subjectNodeId),
        context: {
          nodeId: subjectNodeId,
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
          nodeId: subjectNodeId,
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
