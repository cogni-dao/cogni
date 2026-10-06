// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { renderCatalog } from "./catalog";

describe("renderCatalog", () => {
  it("quotes an all-digit source SHA so YAML preserves its exact identity", () => {
    const sourceSha = "1".repeat(40);
    const catalog = renderCatalog("digits", 3200, 30000, {
      nodeId: "11111111-1111-4111-8111-111111111111",
      ownerWallet: `0x${"2".repeat(40)}`,
      sourceRepo: "https://github.com/cogni-dao/digits.git",
      sourceSha,
    });

    expect(catalog).toContain(`source_sha: "${sourceSha}"\n`);
    expect(parseYaml(catalog)).toMatchObject({ source_sha: sourceSha });
  });
});
