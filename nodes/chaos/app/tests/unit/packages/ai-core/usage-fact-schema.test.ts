// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/ai-core/usage-fact-schema.test`
 * Purpose: Unit tests for UsageFact Zod schemas (strict + hints).
 * Scope: Validates schema accept/reject behavior for billing-authoritative vs external executors. Does not test billing commit logic or DB writes.
 * Invariants:
 *   - USAGE_FACT_VALIDATED: Strict schema enforces usageUnitId for inproc/sandbox
 *   - GRAPHID_REQUIRED: graphId must be namespaced (providerId:graphName)
 * Side-effects: none
 * Links: packages/ai-core/src/usage/usage.ts, work/projects/proj.graph-execution.md
 * @internal
 */

import { UsageFactHintsSchema, UsageFactStrictSchema } from "@cogni/ai-core";
import {
  buildExternalUsageFact,
  buildInprocUsageFact,
  buildSandboxUsageFact,
} from "@tests/_fakes";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// UsageFactStrictSchema
// ---------------------------------------------------------------------------

describe("UsageFactStrictSchema", () => {
  it("accepts valid inproc fact with all required fields", () => {
    const result = UsageFactStrictSchema.safeParse(buildInprocUsageFact());
    expect(result.success).toBe(true);
  });

  it("accepts valid sandbox fact", () => {
    const result = UsageFactStrictSchema.safeParse(buildSandboxUsageFact());
    expect(result.success).toBe(true);
  });

  it("accepts fact with optional fields omitted", () => {
    const minimal = buildInprocUsageFact({
      model: undefined,
      inputTokens: undefined,
      outputTokens: undefined,
      costUsd: undefined,
    });
    const result = UsageFactStrictSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("rejects missing usageUnitId", () => {
    const { usageUnitId: _, ...fact } = buildInprocUsageFact();
    const result = UsageFactStrictSchema.safeParse(fact);
    expect(result.success).toBe(false);
  });

  it("rejects empty usageUnitId", () => {
    const result = UsageFactStrictSchema.safeParse(
      buildInprocUsageFact({ usageUnitId: "" })
    );
    expect(result.success).toBe(false);
  });

  it("rejects missing runId", () => {
    const { runId: _, ...fact } = buildInprocUsageFact();
    const result = UsageFactStrictSchema.safeParse(fact);
    expect(result.success).toBe(false);
  });

  it("rejects non-namespaced graphId (no colon)", () => {
    const result = UsageFactStrictSchema.safeParse(
      buildInprocUsageFact({ graphId: "poet" as `${string}:${string}` })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const formatted = result.error.format();
      expect(JSON.stringify(formatted)).toContain("namespaced");
    }
  });

  it("accepts namespaced graphId with colon", () => {
    const result = UsageFactStrictSchema.safeParse(
      buildInprocUsageFact({ graphId: "sandbox:agent" })
    );
    expect(result.success).toBe(true);
  });

  it("rejects external executor types (langgraph_server)", () => {
    const result = UsageFactStrictSchema.safeParse(
      buildInprocUsageFact({ executorType: "langgraph_server" })
    );
    expect(result.success).toBe(false);
  });

  it("rejects external executor types (claude_sdk)", () => {
    const result = UsageFactStrictSchema.safeParse(
      buildInprocUsageFact({ executorType: "claude_sdk" })
    );
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields (.strict())", () => {
    const fact = { ...buildInprocUsageFact(), unexpectedField: "surprise" };
    const result = UsageFactStrictSchema.safeParse(fact);
    expect(result.success).toBe(false);
  });

  it("rejects negative inputTokens", () => {
    const result = UsageFactStrictSchema.safeParse(
      buildInprocUsageFact({ inputTokens: -1 })
    );
    expect(result.success).toBe(false);
  });

  it("rejects negative costUsd", () => {
    const result = UsageFactStrictSchema.safeParse(
      buildInprocUsageFact({ costUsd: -0.01 })
    );
    expect(result.success).toBe(false);
  });

  it("rejects missing billingAccountId", () => {
    const { billingAccountId: _, ...fact } = buildInprocUsageFact();
    const result = UsageFactStrictSchema.safeParse(fact);
    expect(result.success).toBe(false);
  });

  it("rejects missing virtualKeyId", () => {
    const { virtualKeyId: _, ...fact } = buildInprocUsageFact();
    const result = UsageFactStrictSchema.safeParse(fact);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UsageFactHintsSchema
// ---------------------------------------------------------------------------

describe("UsageFactHintsSchema", () => {
  it("accepts valid external fact with all fields", () => {
    const result = UsageFactHintsSchema.safeParse(
      buildExternalUsageFact({ usageUnitId: "optional-id" })
    );
    expect(result.success).toBe(true);
  });

  it("accepts missing usageUnitId (telemetry hint, not authoritative)", () => {
    const result = UsageFactHintsSchema.safeParse(buildExternalUsageFact());
    expect(result.success).toBe(true);
  });

  it("accepts claude_sdk executor type", () => {
    const result = UsageFactHintsSchema.safeParse(
      buildExternalUsageFact({ executorType: "claude_sdk" })
    );
    expect(result.success).toBe(true);
  });

  it("rejects billing-authoritative executor types (inproc)", () => {
    const result = UsageFactHintsSchema.safeParse(
      buildExternalUsageFact({ executorType: "inproc" })
    );
    expect(result.success).toBe(false);
  });

  it("rejects billing-authoritative executor types (sandbox)", () => {
    const result = UsageFactHintsSchema.safeParse(
      buildExternalUsageFact({ executorType: "sandbox" })
    );
    expect(result.success).toBe(false);
  });

  it("allows unknown fields (.passthrough())", () => {
    const fact = {
      ...buildExternalUsageFact(),
      externalMetadata: { custom: true },
    };
    const result = UsageFactHintsSchema.safeParse(fact);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty("externalMetadata");
    }
  });

  it("requires graphId", () => {
    const { graphId: _, ...fact } = buildExternalUsageFact();
    const result = UsageFactHintsSchema.safeParse(fact);
    expect(result.success).toBe(false);
  });

  it("rejects missing runId", () => {
    const { runId: _, ...fact } = buildExternalUsageFact();
    const result = UsageFactHintsSchema.safeParse(fact);
    expect(result.success).toBe(false);
  });

  it("rejects missing billingAccountId", () => {
    const { billingAccountId: _, ...fact } = buildExternalUsageFact();
    const result = UsageFactHintsSchema.safeParse(fact);
    expect(result.success).toBe(false);
  });
});
