// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/secrets-catalog-loader`
 * Purpose: Asserts the capability-gated fan-out schema (appliesTo/shared) added in design.secrets-catalog-per-node §Amendment v2 loads into the routing record and rejects conflicting routing.
 * Scope: Drives `loadSecretsCatalog` against fixtures + the real repo catalog (load + path resolution). Does NOT exercise the write side or `setup-secrets` per-node value generation.
 * Invariants:
 *   - appliesTo + shared survive into the routing record
 *   - an entry declaring both service: and appliesTo: is rejected at load
 * Side-effects: IO (creates + removes temp catalog dirs under os.tmpdir())
 * Links: docs/design/secrets-catalog-per-node.md, scripts/lib/secrets-catalog-loader.ts
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadSecretsCatalog,
  openBaoPathFor,
} from "../../scripts/lib/secrets-catalog-loader";

let repoRoot: string;

function writeOperatorCatalog(secretsYaml: string): void {
  mkdirSync(join(repoRoot, "infra"), { recursive: true });
  mkdirSync(join(repoRoot, "nodes"), { recursive: true });
  writeFileSync(
    join(repoRoot, "infra", "secrets-catalog.yaml"),
    `secrets:\n${secretsYaml}`
  );
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "cogni-catalog-"));
});
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("secrets-catalog-loader · capability fan-out (v2)", () => {
  it("carries appliesTo + shared into the routing record", () => {
    writeOperatorCatalog(`
  - name: AUTH_SECRET
    tier: A1
    appliesTo: web
    required: true
    category: Core App
    source: agent
    description: NextAuth session key
    steps: ["auto"]
    generate: { kind: base64, bytes: 32 }
  - name: OPENROUTER_API_KEY
    tier: A1
    appliesTo: all-nodes
    shared: true
    required: true
    category: LLM
    source: human
    description: shared OpenRouter key
    steps: ["paste"]
`);
    const { routing } = loadSecretsCatalog({ repoRoot });
    expect(routing.AUTH_SECRET.appliesTo).toBe("web");
    // distinct-per-node (default) → `shared` key omitted, not `false`.
    expect(routing.AUTH_SECRET.shared).toBeUndefined();
    expect(routing.OPENROUTER_API_KEY).toMatchObject({
      appliesTo: "all-nodes",
      shared: true,
    });
    // No name collision despite both being A1 baseline — declared once each.
    expect(routing.AUTH_SECRET.service).toBeUndefined();
  });

  it("rejects an entry that declares both service and appliesTo", () => {
    writeOperatorCatalog(`
  - name: AUTH_SECRET
    tier: A1
    service: _shared
    appliesTo: web
    required: true
    category: Core App
    source: agent
    description: conflicting routing
    steps: ["auto"]
    generate: { kind: base64, bytes: 32 }
`);
    expect(() => loadSecretsCatalog({ repoRoot })).toThrow(
      /mutually exclusive/
    );
  });
});

describe("secrets-catalog-loader · openBaoPathFor (fan-out path resolution)", () => {
  it("resolves distinct per-node paths for an appliesTo+distinct secret", () => {
    const r = { tier: "A1" as const, appliesTo: "web" as const };
    const a = openBaoPathFor(r, "AUTH_SECRET", "node-template", "candidate-a");
    const b = openBaoPathFor(r, "AUTH_SECRET", "canary", "candidate-a");
    expect(a).toBe("cogni/candidate-a/node-template/AUTH_SECRET");
    expect(b).toBe("cogni/candidate-a/canary/AUTH_SECRET");
    expect(a).not.toBe(b); // zero cross-node value reuse — distinct paths
  });

  it("resolves the _shared path for shared:true regardless of node", () => {
    const r = {
      tier: "A1" as const,
      appliesTo: "all-nodes" as const,
      shared: true,
    };
    expect(
      openBaoPathFor(r, "EVM_RPC_URL", "node-template", "candidate-a")
    ).toBe(openBaoPathFor(r, "EVM_RPC_URL", "canary", "candidate-a"));
    expect(openBaoPathFor(r, "EVM_RPC_URL", "x", "candidate-a")).toBe(
      "cogni/candidate-a/_shared/EVM_RPC_URL"
    );
  });
});

describe("secrets-catalog-loader · REAL repo catalog (guards the migration)", () => {
  const repoRoot = execSync("git rev-parse --show-toplevel", {
    encoding: "utf-8",
  }).trim();

  it("loads without collision (canary dup removed) + migrates A1 baseline to appliesTo", () => {
    const { routing } = loadSecretsCatalog({ repoRoot });
    // node-template's A1 now lives operator-domain as capability-gated entries.
    expect(routing.AUTH_SECRET).toMatchObject({ appliesTo: "web" });
    expect(routing.AUTH_SECRET.service).toBeUndefined();
    // Custody: payment/signing keys are payments-gated, never baseline.
    expect(routing.PRIVY_SIGNING_KEY?.appliesTo).toBe("payments");
    // Fan-out yields distinct per-node paths on the real catalog.
    const nt = openBaoPathFor(
      routing.AUTH_SECRET,
      "AUTH_SECRET",
      "node-template",
      "preview"
    );
    const cn = openBaoPathFor(
      routing.AUTH_SECRET,
      "AUTH_SECRET",
      "canary",
      "preview"
    );
    expect(nt).not.toBe(cn);
  });
});
