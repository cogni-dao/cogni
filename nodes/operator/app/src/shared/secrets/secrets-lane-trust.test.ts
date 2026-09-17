// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import {
  canWriteSecretsLane,
  SECRETS_LANE_TRUST,
} from "./secrets-lane-trust.data";

describe("canWriteSecretsLane (bug.5196)", () => {
  it("lets the paying environment custody every lane", () => {
    expect(canWriteSecretsLane("production", "production")).toBe(true);
    expect(canWriteSecretsLane("production", "preview")).toBe(true);
    expect(canWriteSecretsLane("production", "candidate-a")).toBe(true);
  });

  it("refuses every up-trust write, forever", () => {
    expect(canWriteSecretsLane("preview", "production")).toBe(false);
    expect(canWriteSecretsLane("candidate-a", "production")).toBe(false);
    expect(canWriteSecretsLane("candidate-a", "preview")).toBe(false);
  });

  it("does NOT let preview reach candidate-a — only the payer is multi-lane", () => {
    // The rule is an explicit table, not a rank comparison. A `<=` on an ordering
    // would hand preview the candidate-a lane as a side effect; that is not the grant.
    expect(canWriteSecretsLane("preview", "candidate-a")).toBe(false);
    expect(canWriteSecretsLane("preview", "preview")).toBe(true);
  });

  it("denies by default for an environment that never opted in", () => {
    expect(canWriteSecretsLane("staging", "production")).toBe(false);
    expect(canWriteSecretsLane("", "production")).toBe(false);
    expect(canWriteSecretsLane("production", "staging")).toBe(false);
  });

  it("keeps each lane self-writable, so no environment loses what it had", () => {
    for (const lane of Object.keys(SECRETS_LANE_TRUST)) {
      expect(canWriteSecretsLane(lane, lane)).toBe(true);
    }
  });
});
