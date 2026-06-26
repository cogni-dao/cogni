// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: tests for `parseWellKnownIdentity` in `@adapters/server/node-flight/node-prober`.
 * Purpose: Pin the defensive parse of a node's `/.well-known/agent.json` `identity` block — a full
 *   block maps every field, a missing block returns null (graceful degradation for un-projected forks),
 *   a malformed block returns null, and a host-relative brand.thumbnail resolves to an absolute env-host
 *   URL while an already-absolute one is left intact.
 * Scope: Pure parser logic (no network).
 * Side-effects: none
 * Links: src/adapters/server/node-flight/node-prober.adapter.ts
 */

import { describe, expect, it } from "vitest";
import { parseWellKnownIdentity } from "@/adapters/server/node-flight/node-prober.adapter";

const HOST = "beacon.cognidao.org";

describe("parseWellKnownIdentity", () => {
  it("parses a full identity block and resolves a host-relative thumbnail to an absolute env-host URL", () => {
    const body = {
      name: "Cogni Node API",
      identity: {
        name: "beacon",
        hook: "Signal in the noise",
        mission: "A community-owned beacon node",
        brand: {
          icon: "RadioTower",
          thumbnail: "/showcase/beacon.png",
          color: "#0af",
        },
      },
    };
    expect(parseWellKnownIdentity(body, HOST)).toEqual({
      name: "beacon",
      hook: "Signal in the noise",
      mission: "A community-owned beacon node",
      brand: {
        icon: "RadioTower",
        thumbnail: "https://beacon.cognidao.org/showcase/beacon.png",
        color: "#0af",
      },
    });
  });

  it("host-resolves an image-path brand.icon, but leaves a Lucide NAME verbatim", () => {
    const imagePath = {
      identity: {
        name: "operator",
        brand: { icon: "/TransparentBrainOnly.png" },
      },
    };
    expect(parseWellKnownIdentity(imagePath, HOST)?.brand.icon).toBe(
      "https://beacon.cognidao.org/TransparentBrainOnly.png"
    );
    const lucideName = {
      identity: { name: "games", brand: { icon: "Gamepad2" } },
    };
    expect(parseWellKnownIdentity(lucideName, HOST)?.brand.icon).toBe(
      "Gamepad2"
    );
  });

  it("leaves an already-absolute thumbnail URL intact", () => {
    const body = {
      identity: {
        name: "beacon",
        brand: { thumbnail: "https://cdn.example.com/x.png" },
      },
    };
    expect(parseWellKnownIdentity(body, HOST)?.brand.thumbnail).toBe(
      "https://cdn.example.com/x.png"
    );
  });

  it("returns null when the document has no identity block (un-projected fork)", () => {
    const body = { name: "Cogni Node API", version: "v1", endpoints: {} };
    expect(parseWellKnownIdentity(body, HOST)).toBeNull();
  });

  it("collapses undeclared fields to null (partial identity)", () => {
    const body = { identity: { name: "blue" } };
    expect(parseWellKnownIdentity(body, HOST)).toEqual({
      name: "blue",
      hook: null,
      mission: null,
      brand: { icon: null, thumbnail: null, color: null },
    });
  });

  it("returns null on a malformed identity block (missing required name)", () => {
    const body = { identity: { hook: "no name here" } };
    expect(parseWellKnownIdentity(body, HOST)).toBeNull();
  });

  it("returns null for non-object bodies", () => {
    expect(parseWellKnownIdentity(null, HOST)).toBeNull();
    expect(parseWellKnownIdentity("nope", HOST)).toBeNull();
  });
});
