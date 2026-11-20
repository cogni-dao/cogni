// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/work.items.read-events.contract`
 * Purpose: The node's event registry and the package's item read core name the same read events (story.0085), so a Loki query written against the registry finds what the package emits.
 * Scope: Constant parity only.
 * Invariants: EVENT_NAMES_HERE (the package owns the names; the registry repeats them).
 * Side-effects: none
 * @internal
 */

import { WORK_ITEM_READ_EVENTS } from "@cogni/work-items";
import { describe, expect, it } from "vitest";

import { EVENT_NAMES } from "@/shared/observability";

describe("work-item read events", () => {
  it("the registry names equal the package's", () => {
    expect({
      getSuccess: EVENT_NAMES.WORK_ITEMS_GET_SUCCESS,
      getRefused: EVENT_NAMES.WORK_ITEMS_GET_REFUSED,
    }).toEqual(WORK_ITEM_READ_EVENTS);
  });
});
