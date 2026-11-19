// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import { isMetricsBearerAuthorized } from "./_bearer";

const TOKEN = "t".repeat(40);

describe("isMetricsBearerAuthorized", () => {
  it("accepts the configured token, case-insensitive prefix, trimmed", () => {
    expect(isMetricsBearerAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isMetricsBearerAuthorized(`bearer   ${TOKEN}  `, TOKEN)).toBe(true);
  });

  it("refuses a missing header, another scheme, a wrong token and oversize input", () => {
    expect(isMetricsBearerAuthorized(null, TOKEN)).toBe(false);
    expect(isMetricsBearerAuthorized(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(isMetricsBearerAuthorized(`Bearer ${"x".repeat(40)}`, TOKEN)).toBe(
      false
    );
    expect(isMetricsBearerAuthorized(`Bearer ${"t".repeat(600)}`, TOKEN)).toBe(
      false
    );
    expect(isMetricsBearerAuthorized(`Bearer ${"t".repeat(300)}`, TOKEN)).toBe(
      false
    );
  });
});
