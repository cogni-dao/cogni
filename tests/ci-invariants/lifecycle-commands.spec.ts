// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/lifecycle-commands`
 * Purpose: Keep agent lifecycle commands and skills from instructing retired or forbidden delivery steps.
 * Scope: Static line scan of `.claude/commands/*.md` and `.claude/skills/*\/SKILL.md`. Does not run git or touch the network.
 * Invariants:
 *   - NO_STAGING_BASE: no file names `origin/staging`, `--base staging` or "from `staging`"; branches and diffs use `main`.
 *   - NO_PNPM_CHECK_STEP: no file instructs a bare `pnpm check` as a step; mentioning that it needs the human's explicit request is allowed.
 *   - MERGE_VIA_OPERATOR: no file instructs `gh pr merge`; merges go through `POST /api/v1/vcs/merge`.
 * Side-effects: IO (reads committed Markdown)
 * Links: task.5293, story.5103, AGENTS.md (local command budget), .claude/commands/closeout.md
 * @public
 *
 * MATCHER (line-based, deliberately simple):
 * - Staging: any occurrence of the three tokens. Staging is retired, so they have no legitimate use.
 * - `pnpm check`: the bare aggregate (not `pnpm check:docs` etc.) in STEP POSITION, meaning the line,
 *   after Markdown prefixes (indent, `>`, bullets, `1.`, `$`) and an optional leading "Run", starts with
 *   it. A mid-sentence mention ("do not run `pnpm check` locally") is not a step.
 * - `gh pr merge`: any occurrence, unless the same line carries a prohibition (never/not/don't/instead of).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const COMMANDS_DIR = path.join(REPO_ROOT, ".claude/commands");
const SKILLS_DIR = path.join(REPO_ROOT, ".claude/skills");

type Rule = "NO_STAGING_BASE" | "NO_PNPM_CHECK_STEP" | "MERGE_VIA_OPERATOR";

interface Violation {
  rule: Rule;
  line: number;
  text: string;
}

const STAGING =
  /origin\/staging\b|--base[= ]staging\b|\bfrom `?staging`?(?![\w-])/;
const STEP_PREFIX = /^[\s>]*(?:[-*+]\s+|\d+\.\s+)?(?:\$\s+)?(?:run\s+)?`?/i;
const PNPM_CHECK_STEP = /^pnpm check(?![:\w-])/;
const GH_PR_MERGE = /\bgh pr merge\b/;
const PROHIBITION = /\b(?:never|not|don't|instead of)\b/i;

function findViolations(markdown: string): Violation[] {
  const violations: Violation[] = [];
  markdown.split("\n").forEach((text, index) => {
    const line = index + 1;
    if (STAGING.test(text)) {
      violations.push({ rule: "NO_STAGING_BASE", line, text });
    }
    if (PNPM_CHECK_STEP.test(text.replace(STEP_PREFIX, ""))) {
      violations.push({ rule: "NO_PNPM_CHECK_STEP", line, text });
    }
    if (GH_PR_MERGE.test(text) && !PROHIBITION.test(text)) {
      violations.push({ rule: "MERGE_VIA_OPERATOR", line, text });
    }
  });
  return violations;
}

function lifecycleFiles(): string[] {
  const commands = readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(COMMANDS_DIR, name));
  const skills = readdirSync(SKILLS_DIR)
    .map((name) => path.join(SKILLS_DIR, name, "SKILL.md"))
    .filter((file) => existsSync(file));
  return [...commands, ...skills];
}

describe("lifecycle commands matcher", () => {
  it("flags staging bases, pnpm check steps and gh pr merge", () => {
    const fixture = [
      "1. Diff your branch: `git diff origin/staging...HEAD`",
      "2. Open the PR with `gh pr create --base staging`.",
      "3. Branch from `staging`.",
      "4. Run `pnpm check` before pushing.",
      "   pnpm check",
      "5. Merge it: `gh pr merge --admin`",
    ].join("\n");

    expect(
      findViolations(fixture).map(({ rule, line }) => `${line}:${rule}`)
    ).toEqual([
      "1:NO_STAGING_BASE",
      "2:NO_STAGING_BASE",
      "3:NO_STAGING_BASE",
      "4:NO_PNPM_CHECK_STEP",
      "5:NO_PNPM_CHECK_STEP",
      "6:MERGE_VIA_OPERATOR",
    ]);
  });

  it("allows mentions that are not instructions", () => {
    const fixture = [
      "Full suites run in CI. `pnpm check` and the unfiltered `pnpm test` need the human's explicit request.",
      "Read the required CI checks; do not run `pnpm check` locally.",
      "1. Run `pnpm check:docs` and fix any errors until clean.",
      "1. Merge through the operator: `POST /api/v1/vcs/merge`. Never use `gh pr merge`.",
      "Branch from fresh `origin/main` and diff against `origin/main...HEAD`.",
    ].join("\n");

    expect(findViolations(fixture)).toEqual([]);
  });
});

describe("lifecycle commands on the committed tree", () => {
  const files = lifecycleFiles();

  it("scans the lifecycle commands", () => {
    const relative = files.map((file) => path.relative(REPO_ROOT, file));
    expect(relative).toEqual(
      expect.arrayContaining([
        ".claude/commands/implement.md",
        ".claude/commands/review-implementation.md",
        ".claude/commands/closeout.md",
      ])
    );
  });

  it.each(
    files.map((file) => [path.relative(REPO_ROOT, file), file])
  )("%s instructs no staging base, pnpm check step or gh pr merge", (_, file) => {
    expect(findViolations(readFileSync(file, "utf8"))).toEqual([]);
  });
});
