// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/_facades/review/zod-version-cross-package.spec`
 * Purpose: Pin the cross-package Zod-version invariant — proves operator's `instanceof ZodError` recognizes errors thrown by `PrReviewWorkflowInputSchema` from `@cogni/temporal-workflows`.
 * Scope: Unit-level guard against the dual-instance bug fixed in task.0419 revision 3. Does not exercise dispatch logic or Temporal.
 * Invariants:
 *   - ZOD_VERSION_PARITY: schema parse errors are catchable via operator's `import { ZodError } from "zod"` — required for `request.server.ts` schema-parse failures to surface as ZodError in production.
 * Side-effects: none
 * Links: task.0419, packages/temporal-workflows/src/workflows/pr-review.schema.ts
 * @internal
 */

import { PrReviewWorkflowInputSchema } from "@cogni/temporal-workflows";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

describe("PrReviewWorkflowInputSchema — cross-package Zod version parity", () => {
  it("throws a ZodError that operator's ZodError class recognizes via instanceof", () => {
    let caught: unknown;
    try {
      // Intentionally misshapen: empty payload — every required field will fail.
      PrReviewWorkflowInputSchema.parse({});
    } catch (error) {
      caught = error;
    }
    // This is the actual bug guard. If @cogni/temporal-workflows' zod and
    // operator's zod resolve to different installations, this assertion fails
    // and any `if (error instanceof ZodError)` branch in the review facade is
    // dead code in production — exactly the regression revision 3 closes.
    expect(caught).toBeInstanceOf(ZodError);
    expect((caught as ZodError).issues.length).toBeGreaterThan(0);
  });
});
