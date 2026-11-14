// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `nodes/operator/app/scripts/import-work-items-via-api`
 * Purpose: One-shot bulk import of `work/items/*.md` into Doltgres via the deployed `POST /api/v1/work/items` API. Preserves source IDs (e.g. `bug.0153` stays `bug.0153`) by sending the markdown id in the POST body.
 * Scope: One CLI script. Reads markdown via `MarkdownWorkItemAdapter`, POSTs each row.
 * Side-effects: IO (reads markdown files, makes HTTPS POSTs).
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/guides/work-items-importer.md
 * @public
 */

import { execSync } from "node:child_process";

import type { WorkItem } from "@cogni/work-items";
import { MarkdownWorkItemAdapter } from "@cogni/work-items/markdown";

const VALID_TYPES = new Set(["task", "bug", "story", "spike", "subtask"]);
const VALID_STATUSES = new Set([
  "needs_triage",
  "needs_research",
  "needs_design",
  "needs_implement",
  "needs_closeout",
  "needs_merge",
  "done",
  "blocked",
  "cancelled",
]);

function gitToplevel(): string {
  return execSync("git rev-parse --show-toplevel", {
    encoding: "utf8",
  }).trim();
}

function normalizeStatus(s: string | undefined): string | undefined {
  if (!s) return undefined;
  if (VALID_STATUSES.has(s)) return s;
  if (s === "needs_review") return "needs_merge";
  return undefined;
}

function buildBody(item: WorkItem): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: item.id,
    type: item.type,
    title: item.title,
  };
  const summary = (item.summary ?? "").trim();
  if (summary) body.summary = summary;
  if (item.outcome) body.outcome = item.outcome;
  if (item.node && item.node !== "shared") body.node = item.node;
  if (item.projectId) body.projectId = item.projectId;
  if (item.parentId) body.parentId = item.parentId;
  if (item.specRefs?.length) body.specRefs = item.specRefs;
  if (item.labels?.length) body.labels = item.labels;
  if (typeof item.priority === "number") body.priority = item.priority;
  if (typeof item.rank === "number") body.rank = item.rank;
  if (typeof item.estimate === "number") body.estimate = item.estimate;
  const status = normalizeStatus(item.status);
  if (status) body.status = status;
  return body;
}

async function fetchExistingIds(
  api: string,
  token: string,
  ids: ReadonlyArray<string>
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const out = new Set<string>();
  // The list endpoint accepts ?ids=a,b,c — chunk to keep URLs reasonable
  const CHUNK = 50;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const url = `${api}/api/v1/work/items?ids=${encodeURIComponent(slice.join(","))}&limit=500`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) continue;
    const json = (await res.json()) as { items?: Array<{ id: string }> };
    for (const it of json.items ?? []) out.add(it.id);
  }
  return out;
}

async function postOne(
  api: string,
  token: string,
  body: Record<string, unknown>
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${api}/api/v1/work/items`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, data };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const api = argv[argv.indexOf("--api") + 1] ?? "https://preview.cognidao.org";
  const limitFlag = argv.indexOf("--limit");
  const limit =
    limitFlag >= 0 ? Number.parseInt(argv[limitFlag + 1] ?? "0", 10) : 0;
  const dryRun = argv.includes("--dry-run");

  // biome-ignore lint/style/noProcessEnv: one-shot CLI
  const token = process.env.COGNI_KEY;
  if (!token) {
    throw new Error("COGNI_KEY env var must be set");
  }

  const repoRoot = gitToplevel();
  const reader = new MarkdownWorkItemAdapter(repoRoot);
  const { items: all } = await reader.list({});
  const eligible = all.filter((it) => VALID_TYPES.has(it.type));
  const limited = limit > 0 ? eligible.slice(0, limit) : eligible;

  process.stdout.write(
    `[importer] api=${api} repoRoot=${repoRoot} dryRun=${dryRun}\n` +
      `[importer] read ${all.length} items, ${eligible.length} eligible (skipped ${all.length - eligible.length} non-work types)\n`
  );

  // Pre-flight: skip IDs already in the target env (importer is idempotent).
  const existing = dryRun
    ? new Set<string>()
    : await fetchExistingIds(
        api,
        token,
        limited.map((it) => it.id as string)
      );
  const items = limited.filter((it) => !existing.has(it.id as string));
  process.stdout.write(
    `[importer] ${items.length} to POST (${existing.size} already present, skipping)\n`
  );

  let posted = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of items) {
    const body = buildBody(item);
    if (dryRun) {
      process.stdout.write(`[dry] ${item.id}\n`);
      continue;
    }
    const { status, data } = await postOne(api, token, body);
    if (status >= 200 && status < 300) {
      posted += 1;
      if (posted % 25 === 0) {
        process.stdout.write(
          `[importer] progress posted=${posted} skipped=${skipped} failed=${failed} of ${items.length}\n`
        );
      }
    } else if (status === 409) {
      skipped += 1;
    } else {
      failed += 1;
      process.stdout.write(
        `[importer] FAIL ${item.id} status=${status} body=${JSON.stringify(data).slice(0, 200)}\n`
      );
    }
  }

  process.stdout.write(
    `[importer] done. posted=${posted} skipped=${skipped} failed=${failed} of ${items.length}\n`
  );
  return failed > 0 ? 1 : 0;
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    process.stderr.write(
      `[importer] FATAL: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(2);
  });
