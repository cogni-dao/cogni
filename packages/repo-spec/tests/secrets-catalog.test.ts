// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/repo-spec/tests/secrets-catalog`
 * Purpose: Prove the sovereign-node secrets catalog check (bug.5254): real fleet catalog shapes parse,
 *   `workloads` is opt-in and names repo-spec services, and a node cannot declare operator-only fields,
 *   unsafe generators or a schema-invalid entry.
 * Scope: Unit tests of `parseNodeSecretsCatalog` and `catalogSecretKeysFor` only.
 * Invariants: NO_SOURCE_ECHO — a refusal never contains catalog values.
 * Side-effects: none
 * Links: packages/repo-spec/src/secrets-catalog.ts, bug.5254
 */

import { describe, expect, it } from "vitest";
import {
  catalogSecretKeysFor,
  parseNodeSecretsCatalog,
  SecretsCatalogError,
} from "../src/secrets-catalog";

const CTX = { nodeSlug: "red", serviceNames: ["app", "sandbox"] };

const issuesOf = (text: string): string[] => {
  try {
    parseNodeSecretsCatalog(text, CTX);
  } catch (error) {
    if (error instanceof SecretsCatalogError)
      return error.issues.map((i) => i.code);
    throw error;
  }
  return [];
};

const TOKEN_ENTRY = `secrets:
  - name: SANDBOX_EXECD_TOKEN
    tier: A2
    source: agent
    generate: { kind: hex, bytes: 32 }
    workloads: [app, sandbox]
    required: true
    category: Sandbox
    description: Shared execd token.
    steps: []
`;

describe("parseNodeSecretsCatalog", () => {
  it("treats a missing or empty catalog as no entries", () => {
    expect(parseNodeSecretsCatalog(null, CTX)).toEqual([]);
    expect(parseNodeSecretsCatalog("secrets: []\n", CTX)).toEqual([]);
    expect(parseNodeSecretsCatalog("# only comments\n", CTX)).toEqual([]);
  });

  it("parses the fleet's current shape (poly, beacon: source human, appliesTo web, no workloads)", () => {
    const entries = parseNodeSecretsCatalog(
      `secrets:
  - name: X_API_BEARER_TOKEN
    tier: A2
    appliesTo: web
    shared: false
    source: human
    required: false
    category: "X (Twitter)"
    description: >-
      X API v2 bearer token.
    steps:
      - "Create a Project + App in the X developer portal."
`,
      CTX
    );
    expect(entries).toEqual([
      { name: "X_API_BEARER_TOKEN", source: "human", workloads: [] },
    ]);
    expect(catalogSecretKeysFor(entries, "app")).toEqual([]);
  });

  it("projects an entry only into the services its workloads names", () => {
    const entries = parseNodeSecretsCatalog(TOKEN_ENTRY, CTX);
    expect(entries).toEqual([
      {
        name: "SANDBOX_EXECD_TOKEN",
        source: "agent",
        workloads: ["app", "sandbox"],
        generate: { kind: "hex", bytes: 32 },
      },
    ]);
    expect(catalogSecretKeysFor(entries, "app")).toEqual([
      "SANDBOX_EXECD_TOKEN",
    ]);
    expect(catalogSecretKeysFor(entries, "sandbox")).toEqual([
      "SANDBOX_EXECD_TOKEN",
    ]);
    expect(catalogSecretKeysFor(entries, "other")).toEqual([]);
  });

  it("refuses red PR #49's entry: source agent with no generate and no steps", () => {
    const codes = issuesOf(`secrets:
  - name: SANDBOX_EXECD_TOKEN
    tier: A2
    appliesTo: web
    shared: false
    source: agent
    required: false
    category: "Sandbox"
    description: Shared execd access token.
`);
    expect(codes).toEqual(["schema_invalid"]); // steps is required
    // With steps present, the missing generator is the refusal.
    expect(
      issuesOf(
        TOKEN_ENTRY.replace("    generate: { kind: hex, bytes: 32 }\n", "")
      )
    ).toEqual(["schema_invalid"]);
  });

  it("refuses a workloads name that is not a repo-spec service", () => {
    expect(
      issuesOf(TOKEN_ENTRY.replace("[app, sandbox]", "[app, web]"))
    ).toEqual(["unknown_workload"]);
  });

  it("refuses operator-only fields, foreign services, derived values and unsafe generators", () => {
    const entry = (extra: string, source = "agent") => `secrets:
  - name: K
    tier: A2
    source: ${source}
    required: false
    category: c
    description: d
    steps: []
${extra}`;
    expect(
      issuesOf(entry("    generate: { kind: static, value: hunter2 }\n"))
    ).toEqual(["unsupported_generator"]);
    expect(
      issuesOf(entry("    generate: { kind: derive-env, template: x }\n"))
    ).toEqual(["unsupported_generator"]);
    expect(issuesOf(entry("    inheritFrom: operator\n", "human"))).toEqual([
      "operator_only_field",
    ]);
    expect(issuesOf(entry("    shared: true\n", "human"))).toEqual([
      "operator_only_field",
    ]);
    expect(
      issuesOf(entry("    syncTo: github-app-webhook\n", "human"))
    ).toEqual(["operator_only_field"]);
    expect(issuesOf(entry("    service: poly\n", "human"))).toEqual([
      "foreign_service",
    ]);
    expect(
      issuesOf(
        entry("    generate: { kind: derived, source: node-dbs }\n", "derived")
      )
    ).toEqual(["unsupported_source", "unsupported_generator"]);
  });

  it("refuses duplicate names, invalid YAML and an oversized catalog without echoing input", () => {
    const dup = TOKEN_ENTRY + TOKEN_ENTRY.replace("secrets:\n", "");
    expect(issuesOf(dup)).toEqual(["duplicate_name"]);
    expect(issuesOf("secrets: [\n")).toEqual(["yaml_invalid"]);
    expect(issuesOf(`# ${"x".repeat(70 * 1024)}\nsecrets: []\n`)).toEqual([
      "too_large",
    ]);
    const marker = "sk-live-MARKER123";
    let message = "";
    try {
      parseNodeSecretsCatalog(
        `secrets:\n  - name: K\n    tier: ${marker}\n    source: ${marker}\n    consumedBy: [${marker}]\n    inheritEnvironmentByLane: { ${marker}: lane }\n    required: false\n    category: c\n    description: d\n    steps: []\n`,
        CTX
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("does not match the secrets catalog schema");
    expect(message).not.toContain("MARKER123");
  });
});
