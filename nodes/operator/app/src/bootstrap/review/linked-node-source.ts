// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/review/linked-node-source`
 * Purpose: Build the host-owned reader of a LINKED node's grounding for the pr-review run (story.0038):
 *   X's mission, governing index, architect entry and rule bodies, read through X's X-issued key.
 * Scope: Composition + orchestration. The key comes from the broker under the system principal
 *   (`resolveServiceConnection`), every call goes through the host-bound transport, and the result goes
 *   into the host preamble. No tool, model argument or request field reaches this path.
 * Invariants:
 *   - TWO_PATHS_ONLY: `GET /api/v1/knowledge/index` and `GET /api/v1/knowledge/{id}`; the transport
 *     refuses everything else.
 *   - BOUNDED: at most 20 rule bodies and 96 KiB of rule text; one 1 MiB response cap per call.
 *   - FAIL_CLOSED: no link, a rejected key (401, which also marks the link `needs_reenroll`), an
 *     unreadable index or a missing mission throws `LinkedNodeSourceError`; the run ends and the review
 *     reports "could not evaluate". A single unreadable rule is skipped.
 *   - MISSION_FROM_PINNED_BASE: X's mission is `intent.mission` of its repo-spec at the PR's pinned base
 *     commit, read with the review GitHub App (X's own declared source), never from the request.
 *   - ORIGIN_FROM_REGISTRY: the audience is derived from X's registry row, not from the subject.
 * Side-effects: IO (broker read, HTTPS to node X, GitHub read), log events via the transport
 * Links: src/adapters/server/node-service-links/node-host-transport.ts, story.0038,
 *   https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import {
  createNodeHostTransport,
  selectArchitectEntryId,
} from "@/adapters/server";
import { registeredNodeOrigin } from "@/features/node-service-links/node-origin";
import { resolveNodeRef } from "@/features/nodes/node-lookup";
import {
  type LinkedNodeSource,
  LinkedNodeSourceError,
  type LinkedNodeSourceReader,
} from "@/ports";
import { serverEnv } from "@/shared/env";
import { makeLogger } from "@/shared/observability";
import { getContainer, resolveServiceDb } from "../container";
import { getNodeServiceLinkService } from "../node-service-links";
import { createReviewGithubPlane } from "./resolve-review-route";

/** Rule bodies read per linked run: at most 20 entries and 96 KiB. */
export const LINKED_MAX_RULE_ENTRIES = 20;
export const LINKED_MAX_RULE_BYTES = 96 * 1024;

const SERVICE = "git-review" as const;
const INDEX_PATH = "/api/v1/knowledge/index";

interface IndexRow {
  readonly id: string;
  readonly domain: string;
  readonly entryType: string;
  readonly useWhen: string;
}

function parseIndexRows(body: string): IndexRow[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }
  const items =
    json &&
    typeof json === "object" &&
    Array.isArray((json as { items?: unknown }).items)
      ? ((json as { items: unknown[] }).items as unknown[])
      : [];
  const rows: IndexRow[] = [];
  for (const item of items) {
    const r = item as Partial<IndexRow> | null;
    if (
      r &&
      typeof r.id === "string" &&
      typeof r.domain === "string" &&
      typeof r.entryType === "string" &&
      typeof r.useWhen === "string"
    ) {
      rows.push({
        id: r.id,
        domain: r.domain,
        entryType: r.entryType,
        useWhen: r.useWhen,
      });
    }
  }
  return rows;
}

function entryBody(body: string): string | null {
  try {
    const json = JSON.parse(body) as {
      content?: unknown;
      entry?: { content?: unknown };
    };
    const content = json.entry?.content ?? json.content;
    return typeof content === "string" && content.trim() ? content : null;
  } catch {
    return null;
  }
}

/** The host-owned reader used by the in-process provider for linked-node review runs. */
export function createLinkedNodeSourceReader(): LinkedNodeSourceReader {
  const log = makeLogger({ component: "linked-node-source" });
  const transport = createNodeHostTransport({ log });

  return async (subject): Promise<LinkedNodeSource> => {
    const container = getContainer();
    const broker = container.serviceConnectionResolver;
    const links = getNodeServiceLinkService();
    if (!broker || !links) throw new LinkedNodeSourceError("node_not_linked");

    const node = await resolveNodeRef(resolveServiceDb(), subject.nodeId);
    if (!node || node.nodeId !== subject.nodeId) {
      throw new LinkedNodeSourceError("node_not_linked");
    }
    const origin = registeredNodeOrigin({
      slug: node.slug,
      deployEnvs: node.deployEnvs,
      env: serverEnv(),
    });
    if (!origin) throw new LinkedNodeSourceError("node_origin_unresolved");

    let connection: Awaited<ReturnType<typeof broker.resolveServiceConnection>>;
    try {
      connection = await broker.resolveServiceConnection({ audience: origin });
    } catch {
      throw new LinkedNodeSourceError("node_not_linked");
    }

    const get = async (path: string): Promise<string> => {
      const result = await transport.get({
        connection,
        audience: origin,
        targetNodeId: subject.nodeId,
        path,
      });
      if (!result.ok) throw new LinkedNodeSourceError("node_hub_unreadable");
      if (result.status === 401) {
        await links.markKeyRejected(origin, SERVICE);
        throw new LinkedNodeSourceError("node_key_rejected");
      }
      if (result.status !== 200) {
        throw new LinkedNodeSourceError("node_hub_unreadable");
      }
      return result.body;
    };

    const rows = parseIndexRows(await get(INDEX_PATH));

    let architect: LinkedNodeSource["architect"];
    const architectId = selectArchitectEntryId(rows, node.slug);
    if (architectId) {
      try {
        const content = entryBody(
          await get(`/api/v1/knowledge/${architectId}`)
        );
        if (content) {
          architect = {
            id: architectId,
            content,
            sourceRef: `hub:${architectId}`,
          };
        }
      } catch (error) {
        if (
          error instanceof LinkedNodeSourceError &&
          error.code === "node_key_rejected"
        ) {
          throw error;
        }
        // Best effort, like the operator's own architect read: the review proceeds without it.
      }
    }

    const rules: Array<{ id: string; content: string }> = [];
    let ruleBytes = 0;
    for (const row of rows) {
      if (row.entryType !== "rule") continue;
      if (rules.length >= LINKED_MAX_RULE_ENTRIES) break;
      let content: string | null = null;
      try {
        content = entryBody(await get(`/api/v1/knowledge/${row.id}`));
      } catch (error) {
        if (
          error instanceof LinkedNodeSourceError &&
          error.code === "node_key_rejected"
        ) {
          throw error;
        }
        continue; // one unreadable rule is skipped
      }
      if (!content) continue;
      const size = Buffer.byteLength(content, "utf8");
      if (ruleBytes + size > LINKED_MAX_RULE_BYTES) continue;
      ruleBytes += size;
      rules.push({ id: row.id, content });
    }

    const plane = createReviewGithubPlane(log);
    if (!plane) throw new LinkedNodeSourceError("node_mission_unavailable");
    let mission: string | null;
    try {
      mission = await plane.readNodeMission({
        owner: subject.owner,
        repo: subject.repo,
        ref: subject.baseSha,
      });
    } catch {
      throw new LinkedNodeSourceError("node_mission_unavailable");
    }
    if (!mission) throw new LinkedNodeSourceError("node_mission_unavailable");

    return {
      origin,
      mission: {
        content: mission,
        sourceRef: `${subject.owner}/${subject.repo}@${subject.baseSha.slice(0, 8)}:.cogni/repo-spec.yaml#intent.mission`,
        buildSha: null,
      },
      governingIndex: rows,
      ...(architect ? { architect } : {}),
      rules,
    };
  };
}
