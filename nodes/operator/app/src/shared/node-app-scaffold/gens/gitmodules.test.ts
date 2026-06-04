// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";
import { renderGitmodules } from "./gitmodules";

const URL = "https://github.com/Cogni-DAO/acme-node.git";

describe("renderGitmodules", () => {
  it("creates the file from null with one stanza", () => {
    expect(renderGitmodules(null, "acme", URL)).toBe(
      `[submodule "nodes/acme"]\n\tpath = nodes/acme\n\turl = ${URL}\n`
    );
  });

  it("creates the file from empty string", () => {
    expect(renderGitmodules("", "acme", URL)).toContain(
      '[submodule "nodes/acme"]'
    );
  });

  it("appends a second node below an existing stanza, separated by a blank line", () => {
    const existing =
      '[submodule "nodes/acme"]\n\tpath = nodes/acme\n\turl = https://github.com/Cogni-DAO/acme-node.git\n';
    const out = renderGitmodules(
      existing,
      "beta",
      "https://github.com/Cogni-DAO/beta-node.git"
    );
    expect(out.startsWith(existing.trimEnd())).toBe(true);
    expect(out).toContain('[submodule "nodes/beta"]');
    expect(out).toContain(
      "\turl = https://github.com/Cogni-DAO/beta-node.git\n"
    );
    // exactly two stanzas
    expect(out.match(/\[submodule /g)).toHaveLength(2);
  });

  it("is idempotent — re-rendering an existing slug returns the input unchanged", () => {
    const existing = renderGitmodules(null, "acme", URL);
    expect(renderGitmodules(existing, "acme", URL)).toBe(existing);
  });
});
