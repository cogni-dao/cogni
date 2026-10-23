// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/evals/guidance-routing/run`
 * Purpose: Thin orchestration for the guidance-routing eval: fetch the live governing rows → blind model selection per gold task → score → decision-table verdict.
 * Scope: External lane (live node + API key + real model calls); not PR CI. Read-only against the hub and work items; grading lives in score.ts.
 * Invariants:
 *   - BLIND_SELECTOR: the selector sees only the task text and the rows the mechanism exposes, never the labels.
 *   - NO_INTERNAL_TEXT_COMMITTED: task titles and summaries are fetched at run time, never stored in gold.json.
 *   - MEAN_OF_RUNS: the verdict uses the mean of `--runs` (default thresholds.minRuns) selector runs.
 *   - EXIT_CODE_IS_VERDICT: 0 = the decision table ships the mechanism (row 1 or 5) or a --ceiling-only report; 1 = any other row; 3 = INCONCLUSIVE (a row needs a mechanism that was not measured, or a read failed).
 *   - RESULTS_NOT_COMMITTED: `--out <file>` writes the JSON scorecard wherever the caller chooses.
 * Side-effects: IO (HTTP reads to the node, model calls to its chat completions route or another OpenAI-compatible endpoint, optional --out file)
 * Links: evals/guidance-routing/README.md, score.ts
 * @public
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isGoverningEntryType } from "../../src/domain/governing";
import {
  ceiling,
  chunkMessage,
  type Decision,
  type DecisionInput,
  decide,
  type Gold,
  meanOfRuns,
  parsePicks,
  type RunScore,
  type Selection,
  scoreRun,
  type Thresholds,
} from "./score";

interface Row {
  id: string;
  entryType: string;
  domain: string;
  useWhen: string | null;
}

interface CognitionBody {
  buildSha: string;
  markdown: string;
  governingIndex?: Row[];
  /** Pre-governing builds served the skill/guide/playbook subset here. */
  skillsIndex?: (Row & { title?: string })[];
  domainPointers: { domain: string; description: string | null }[];
}

type Mechanism = "A" | "T" | "T+method";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const gold = JSON.parse(
  readFileSync(path.join(DIR, "gold.json"), "utf8")
) as Gold;
const th = JSON.parse(
  readFileSync(path.join(DIR, "thresholds.json"), "utf8")
) as Thresholds;

const argOf = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const strip = (u: string) => u.replace(/\/$/, "");
const BASE = strip(process.env.EVAL_BASE_URL ?? "https://cognidao.org");
const KEY = process.env.EVAL_API_KEY ?? process.env.COGNI_NODE_API_KEY;
const WORK_BASE = strip(
  process.env.EVAL_WORK_BASE_URL ?? "https://cognidao.org"
);
const WORK_KEY = process.env.EVAL_WORK_API_KEY ?? KEY;
/**
 * The selector endpoint: any OpenAI-compatible chat completions URL. Default is
 * the node's own route with the free `gpt-oss-120b`, routed through a graph
 * (`EVAL_GRAPH`, default `pr-review`). That route caps each MESSAGE at 4,000
 * characters (not each request), so the prompt is split across consecutive
 * user messages of at most `EVAL_MAX_MESSAGE_CHARS` (default 3,900 on the node
 * route; unset = one message for an external endpoint).
 */
const EXTERNAL_LLM = process.env.EVAL_COMPLETIONS_URL;
const LLM_URL = EXTERNAL_LLM ?? `${BASE}/api/v1/chat/completions`;
const LLM_KEY = process.env.EVAL_COMPLETIONS_API_KEY ?? KEY;
const MODEL = process.env.EVAL_MODEL ?? "gpt-oss-120b";
const GRAPH =
  process.env.EVAL_GRAPH ?? (EXTERNAL_LLM ? undefined : "pr-review");
const MAX_MESSAGE_CHARS = process.env.EVAL_MAX_MESSAGE_CHARS
  ? Number(process.env.EVAL_MAX_MESSAGE_CHARS)
  : EXTERNAL_LLM
    ? undefined
    : 3900;
/** Only `--ceiling-only` runs without a selector endpoint: it reports the reachable recall ceiling and exits. */
const CEILING_ONLY = process.argv.includes("--ceiling-only");
const MECHANISM = (argOf("--mechanism") ?? "A") as Mechanism;
const RUNS = Number(argOf("--runs") ?? th.minRuns);
/** `bundle` (default) reads the live cognition bundle; any other value is a JSON file of rows (e.g. core__knowledge_index output). */
const ROWS = argOf("--rows") ?? "bundle";
const OUT = argOf("--out");

if (!KEY) {
  console.error("EVAL_API_KEY or COGNI_NODE_API_KEY is required");
  process.exit(2);
}
if (!["A", "T", "T+method"].includes(MECHANISM)) {
  console.error("--mechanism must be A, T or T+method");
  process.exit(2);
}
if (!CEILING_ONLY && EXTERNAL_LLM && !process.env.EVAL_COMPLETIONS_API_KEY) {
  console.error("EVAL_COMPLETIONS_URL needs EVAL_COMPLETIONS_API_KEY");
  process.exit(2);
}

async function get<T>(
  base: string,
  key: string | undefined,
  p: string
): Promise<T> {
  const res = await fetch(`${base}${p}`, {
    headers: { authorization: `Bearer ${key}`, "user-agent": "curl/8.4.0" },
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`GET ${base}${p} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function complete(prompt: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(LLM_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${LLM_KEY}`,
        "content-type": "application/json",
        "user-agent": "curl/8.4.0",
      },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        ...(GRAPH ? { graph_name: GRAPH } : {}),
        messages: chunkMessage(prompt, MAX_MESSAGE_CHARS).map((content) => ({
          role: "user",
          content,
        })),
      }),
    });
    const text = await res.text();
    if (res.ok) {
      const body = JSON.parse(text) as {
        choices?: { message?: { content?: string } }[];
      };
      return body.choices?.[0]?.message?.content ?? "";
    }
    if (res.status < 500 && res.status !== 429)
      throw new Error(`completion → ${res.status}: ${text.slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error("completion failed after 3 attempts");
}

const table = (rows: readonly Row[]) =>
  [
    "| entry | type | domain | use when |",
    "| --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.entryType} | ${r.domain} | ${(r.useWhen ?? "").replace(/\|/g, "/")} |`
    ),
  ].join("\n");

async function taskText(id: string): Promise<string> {
  const item = await get<{ title: string; summary?: string | null }>(
    WORK_BASE,
    WORK_KEY,
    `/api/v1/work/items/${encodeURIComponent(id)}`
  );
  return `${item.title}\n\n${(item.summary ?? "").slice(0, 300)}`;
}

/** BLIND_SELECTOR: one ranked pick of up to maxPicks ids from `rows`. */
async function select(task: string, rows: readonly Row[]): Promise<string[]> {
  const prompt = [
    "You route a software task to the hub guidance that governs it: the skills, guides, rules, designs, decisions and references an engineer must follow while doing the task.",
    "Each row below is one hub entry with the situation it applies to (use when).",
    "",
    "Task:",
    task,
    "",
    "Hub entries:",
    table(rows),
    "",
    `Return ONLY a JSON array of up to ${th.maxPicks} entry ids from the table, most governing first. No prose.`,
  ].join("\n");
  return parsePicks(
    await complete(prompt),
    new Set(rows.map((r) => r.id)),
    th.maxPicks
  );
}

/** Approach T step 1: pick 1–3 shelves from the domain pointers. */
async function pickShelves(
  task: string,
  domains: CognitionBody["domainPointers"]
): Promise<string[]> {
  const prompt = [
    "You route a software task to the knowledge shelves (domains) most likely to hold the guidance that governs it.",
    "",
    "Task:",
    task,
    "",
    "Shelves:",
    ...domains.map((d) => `- ${d.domain}: ${d.description ?? ""}`),
    "",
    "Return ONLY a JSON array of 1 to 3 shelf names, best first. No prose.",
  ].join("\n");
  return parsePicks(
    await complete(prompt),
    new Set(domains.map((d) => d.domain)),
    3
  );
}

async function shelfRows(domain: string): Promise<Row[]> {
  const body = await get<{ items: Row[] }>(
    BASE,
    KEY,
    `/api/v1/knowledge/index?domain=${encodeURIComponent(domain)}&limit=1000`
  );
  // The route has no type filter; the pointer tells agents to keep governing rows.
  return body.items.filter(
    (r) => isGoverningEntryType(r.entryType) && r.useWhen
  );
}

async function main(): Promise<void> {
  const cognition = await get<CognitionBody>(BASE, KEY, "/api/v1/cognition");
  const bundleBytes = new TextEncoder().encode(cognition.markdown).byteLength;
  let rows: Row[];
  let rowsSource: string;
  if (ROWS !== "bundle") {
    const file = JSON.parse(readFileSync(ROWS, "utf8")) as
      | { entries?: Row[] }
      | Row[];
    rows = Array.isArray(file) ? file : (file.entries ?? []);
    rowsSource = `file ${ROWS}`;
  } else if (cognition.governingIndex) {
    rows = cognition.governingIndex;
    rowsSource = "bundle governingIndex";
  } else {
    rows = (cognition.skillsIndex ?? []).map((r) => ({
      id: r.id,
      entryType: r.entryType,
      domain: r.domain,
      useWhen: r.useWhen ?? r.title ?? null,
    }));
    rowsSource = "bundle skillsIndex (pre-governing build)";
  }

  const rulesInRows = rows.filter((r) => r.entryType === "rule").length;
  const reach = ceiling(
    gold,
    rows.map((r) => r.id)
  );
  const header = `build \`${cognition.buildSha}\` · ${BASE} · rows ${rows.length} (${rulesInRows} rules, ${rowsSource}) · bundle ${bundleBytes} B`;
  const reachLine = `reachable ceiling (no model): recall ${reach.all.hits}/${reach.all.total} = ${reach.all.recall.toFixed(3)} · rules ${reach.rules.hits}/${reach.rules.total} = ${reach.rules.recall.toFixed(3)}`;
  if (CEILING_ONLY) {
    console.log(
      [
        "### guidance-routing eval — ceiling only",
        "",
        header,
        "",
        reachLine,
      ].join("\n")
    );
    if (OUT)
      writeFileSync(
        OUT,
        `${JSON.stringify({ baseUrl: BASE, buildSha: cognition.buildSha, rowsSource, rows: rows.length, rulesInRows, bundleBytes, ceiling: reach }, null, 2)}\n`
      );
    return;
  }

  const texts = new Map<string, string>();
  for (const t of gold.tasks) texts.set(t.id, await taskText(t.id));

  const runs: { selections: Selection[]; score: RunScore }[] = [];
  for (let run = 0; run < RUNS; run++) {
    const selections: Selection[] = [];
    for (const t of gold.tasks) {
      const task = texts.get(t.id) as string;
      let candidates = rows;
      if (MECHANISM !== "A") {
        const shelves = await pickShelves(task, cognition.domainPointers);
        if (MECHANISM === "T+method" && !shelves.includes("method"))
          shelves.push("method");
        candidates = (await Promise.all(shelves.map(shelfRows))).flat();
      }
      selections.push({ taskId: t.id, picks: await select(task, candidates) });
    }
    runs.push({ selections, score: scoreRun(gold, selections) });
    console.error(
      `run ${run + 1}/${RUNS}: ${JSON.stringify(runs[run]?.score)}`
    );
  }

  const mean = meanOfRuns(
    runs.map((r) => r.score),
    th.minRuns
  );
  const input: DecisionInput =
    MECHANISM === "A"
      ? {
          bundleBytes,
          A: { recallAt5: mean.recallAt5, rulesAt5: mean.rulesAt5 },
        }
      : { bundleBytes, T: { recallAt10: mean.recallAt10 } };
  const decision: Decision = decide(input, th);

  const card = {
    baseUrl: BASE,
    buildSha: cognition.buildSha,
    mechanism: MECHANISM,
    rowsSource,
    rows: rows.length,
    rulesInRows,
    bundleBytes,
    model: MODEL,
    ceiling: reach,
    runs: runs.map((r) => r.score),
    mean,
    decision,
    selections: runs.map((r) => r.selections),
  };
  const f = (x: number) => x.toFixed(3);
  console.log(
    [
      `### guidance-routing eval — ${decision.ship ? "SHIP" : decision.row === null ? "INCONCLUSIVE" : "NO SHIP"}`,
      "",
      `${header} · mechanism ${MECHANISM} · model ${MODEL}${GRAPH ? ` via ${GRAPH}` : ""} · ${RUNS} runs`,
      "",
      reachLine,
      "",
      "| metric | mean | runs |",
      "| --- | --- | --- |",
      ...(["recallAt3", "recallAt5", "recallAt10", "rulesAt5"] as const).map(
        (m) =>
          `| ${m} | ${f(mean[m])} | ${runs.map((r) => f(r.score[m])).join(", ")} |`
      ),
      "",
      `decision row ${decision.row ?? "-"}: ${decision.action}`,
    ].join("\n")
  );
  if (OUT) writeFileSync(OUT, `${JSON.stringify(card, null, 2)}\n`);
  process.exit(decision.ship ? 0 : decision.row === null ? 3 : 1);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(3);
});
