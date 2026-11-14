// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/github-org-rename-config`
 * Purpose: Pins cutover-critical GitHub owner references for the Cogni org rename.
 * Scope: Static config checks only. Does NOT call GitHub or inspect runtime secrets.
 * Invariants: CANONICAL_GITHUB_OWNER.
 * Side-effects: IO (reads repo config files)
 * Links: https://cognidao.org/knowledge/eso-secret-sync-gate
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const OLD_OWNER = "Cogni-DAO";
const NEW_OWNER = "cogni-dao";

const canonicalOwnerFiles = [
  ".cogni/sync-manifest.yaml",
  ".cogni/sync-manifest.schema.json",
  ".github/CODEOWNERS",
  ".env.local.example",
  ".env.test.example",
  "infra/github/README.md",
  "infra/provision/cherry/base/terraform.tfvars.example",
  "infra/provision/cherry/base/variables.tf",
  "infra/k8s/overlays/production/operator/kustomization.yaml",
] as const;

function readRepoFile(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), "utf8");
}

function withoutSpdxMetadata(body: string): string {
  return body
    .split("\n")
    .filter((line) => !line.includes("SPDX-"))
    .join("\n");
}

describe("GitHub org rename cutover config", () => {
  it.each(
    canonicalOwnerFiles
  )("%s uses the canonical lower-case GitHub owner", (file) => {
    const body = withoutSpdxMetadata(readRepoFile(file));
    expect(body).toContain(NEW_OWNER);
    expect(body).not.toContain(OLD_OWNER);
  });
});
