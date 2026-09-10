// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/packages/repo-spec/deployment-activation`
 * Purpose: Prove the deployment-block splice the operator mints into an existing node repo-spec.
 * Scope: Pure string transform + parse round-trip. Does not perform I/O.
 * Invariants: SCAFFOLD_AND_GATE_SHARE_ONE_VALUE, NEVER_OVERWRITE_A_DECLARATION, IDEMPOTENT_SPLICE.
 * Side-effects: none
 * Links: packages/repo-spec/src/deployment-activation.ts, task.5083, story.5016
 * @public
 */

import {
  COGNI_NODE_APP_V1_DEPLOYMENT,
  hasDeclaredNodeDeployment,
  hasDeploymentActivationSpec,
  parseRepoSpec,
  renderDeploymentActivationSpec,
} from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

/** A pre-deployment-contract node spec, comments included (the levelup/beacon/poly shape). */
const LEGACY_SPEC = `# governance-managed node configuration — DO NOT hand-edit
schema_version: "0.1.4"
node_id: "00000000-0000-4000-8000-000000000001"
intent:
  name: test-cog
  mission: "test deployment splice"
governance:
  # DAO authority for this node
  chain_id: "8453"
payments:
  status: pending_activation
`;

describe("renderDeploymentActivationSpec", () => {
  const spliced = renderDeploymentActivationSpec(LEGACY_SPEC);

  it("appends the stock cogni-node-app-v1 declaration when the block is absent", () => {
    const parsed = parseYaml(spliced) as Record<string, unknown>;
    expect(parsed.deployment).toEqual(COGNI_NODE_APP_V1_DEPLOYMENT);
    // The full spec still parses through the real repo-spec parser and reads as declared.
    const spec = parseRepoSpec(spliced);
    expect(hasDeclaredNodeDeployment(spec)).toBe(true);
    expect(spec.deployment).toEqual(COGNI_NODE_APP_V1_DEPLOYMENT);
  });

  it("preserves the existing content byte-exact (comments, ordering, identity)", () => {
    expect(spliced.startsWith(LEGACY_SPEC)).toBe(true);
    expect(spliced).toContain(
      "# governance-managed node configuration — DO NOT hand-edit"
    );
    expect(spliced).toContain("# DAO authority for this node");
    const parsed = parseYaml(spliced) as Record<string, unknown>;
    expect(parsed.node_id).toBe("00000000-0000-4000-8000-000000000001");
    expect(parsed.payments).toEqual({ status: "pending_activation" });
  });

  it("is idempotent: re-splicing the output is a byte-exact no-op", () => {
    expect(renderDeploymentActivationSpec(spliced)).toBe(spliced);
  });

  it("never overwrites a node's own hand-authored declaration", () => {
    const custom = `${LEGACY_SPEC}
deployment:
  services:
    - name: app
      artifact:
        name: app
      port: 4000
      visibility: public
      resources:
        cpu_units: 1
        memory_mi: 1024
        storage_mi: 2048
`;
    expect(renderDeploymentActivationSpec(custom)).toBe(custom);
  });

  it("does not double-append onto unparseable text carrying a top-level deployment key", () => {
    const corrupt = 'deployment:\n  services: [b0rked: {"unclosed"\n';
    expect(renderDeploymentActivationSpec(corrupt)).toBe(corrupt);
  });

  it("normalizes trailing whitespace to one separator blank line", () => {
    const raggedTail = `${LEGACY_SPEC}\n\n\n`;
    const out = renderDeploymentActivationSpec(raggedTail);
    expect(out).toBe(spliced);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });
});

describe("hasDeploymentActivationSpec", () => {
  it("distinguishes a declared block from a legacy spec", () => {
    expect(hasDeploymentActivationSpec(LEGACY_SPEC)).toBe(false);
    expect(
      hasDeploymentActivationSpec(renderDeploymentActivationSpec(LEGACY_SPEC))
    ).toBe(true);
  });

  it("returns false on unparseable text and non-mapping documents", () => {
    expect(hasDeploymentActivationSpec('deployment: {"unclosed\n')).toBe(false);
    expect(hasDeploymentActivationSpec("- just\n- a\n- list\n")).toBe(false);
  });
});
