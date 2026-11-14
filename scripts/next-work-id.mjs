#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/next-work-id`
 * Purpose: Scan work/items/*.md frontmatter and print the next available numeric ID.
 * Scope: Reads legacy markdown work item files only; does not write files.
 * Invariants: NEXT_ID_SCANS_ITEMS — ID allocation does not depend on a generated index.
 * Side-effects: IO (filesystem reads)
 * Links: [Work README](https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/work/README.md)
 * @public
 */

import { readFileSync } from "node:fs";
import fg from "fast-glob";
import { parse as parseYaml } from "yaml";

const ROOT = process.cwd();

function extractId(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  try {
    const props = parseYaml(match[1]);
    return props?.id ? String(props.id).trim() : null;
  } catch {
    return null;
  }
}

function main() {
  const files = fg.sync(
    [
      "work/items/**/*.md",
      "!work/items/_index.md",
      "!work/items/_archive/**",
      "!work/items/_templates/**",
    ],
    { cwd: ROOT }
  );

  let maxNum = 0;

  for (const file of files) {
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const id = extractId(raw);
    if (!id) continue;

    const m = id.match(/\.(\d+)$/);
    if (m) {
      const n = Number(m[1]);
      if (n > maxNum) maxNum = n;
    }
  }

  const next = String(maxNum + 1).padStart(4, "0");
  process.stdout.write(next);
}

main();
