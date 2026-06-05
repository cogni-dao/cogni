// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";
import { renderCatalog } from "@/shared/node-app-scaffold/gens/catalog";

describe("renderCatalog", () => {
  it("renders inline node catalog without submodule source metadata", () => {
    const out = renderCatalog("acme", 3200, 30400);
    expect(out).toContain("name: acme\n");
    expect(out).not.toContain("source_repo:");
    expect(out).not.toContain("image_repository:");
  });

  it("renders submodule source metadata for child image resolution", () => {
    const out = renderCatalog("ay", 3200, 30400, {
      sourceRepo: "https://github.com/cogni-test-org/ay.git",
    });

    expect(out).toContain(
      "source_repo: https://github.com/cogni-test-org/ay.git\n"
    );
    expect(out).toContain(
      "image_repository: ghcr.io/cogni-test-org/cogni-node-template\n"
    );
  });
});
