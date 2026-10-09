// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { isSameOriginMutation } from "@/app/api/v1/agent/_shared";

describe("agent cookie mutation origin", () => {
  it("accepts an exact Origin/Host match", () => {
    const request = new Request("https://node.example/api/v1/agent/spawn-grants", {
      method: "POST",
      headers: { host: "node.example", origin: "https://node.example" },
    });

    expect(isSameOriginMutation(request)).toBe(true);
  });

  it.each([
    { host: "node.example", origin: null },
    { host: null, origin: "https://node.example" },
    { host: "node.example", origin: "https://evil.example" },
    { host: "node.example", origin: "not-a-url" },
  ])("fails closed for %#", ({ host, origin }) => {
    const headers = new Headers();
    if (host) headers.set("host", host);
    if (origin) headers.set("origin", origin);
    const request = new Request(
      "https://node.example/api/v1/agent/recovery-grants",
      { method: "POST", headers }
    );

    expect(isSameOriginMutation(request)).toBe(false);
  });
});
