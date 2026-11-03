// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: tests for `service=deploy` in `@features/nodes/observability-logs` (task.5400).
 * Purpose: A node developer reads ITS OWN node-deploy sequencer events through the node-scoped log
 *   proxy. The sequencer is an operator-side stream with no trustworthy `node` label, so the node pin
 *   is a FORCED pipeline stage. These tests pin that another node's events are unreachable: the pin is
 *   always emitted, always sits between the selector and any caller stage, and a caller can only narrow.
 * Scope: Pure logic only.
 * Links: src/features/nodes/observability-logs.ts, task.5400, story.5127
 */

import { describe, expect, it } from "vitest";
import {
  ObservabilityQueryError,
  scopeNodeLogQL,
} from "@/features/nodes/observability-logs";

const NODE = "f97f68f2-8406-4a3b-b5a9-d579b779f19d";
const OTHER = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const SELECTOR = '{env="production", service="sequencer"}';
const PIN = `|= "node_deploy" | json | nodeId="${NODE}"`;

const scope = (query?: string, env: "production" | "preview" = "production") =>
  scopeNodeLogQL({ env, nodeId: NODE, service: "deploy", query });

describe("scopeNodeLogQL with ?service=deploy (DEPLOY_EVENTS_PIN_BY_LINE)", () => {
  it("selects the sequencer stream and pins the node by its log line, for an empty query", () => {
    expect(scope()).toBe(`${SELECTOR} ${PIN}`);
    expect(scope("  ", "preview")).toBe(
      `{env="preview", service="sequencer"} ${PIN}`
    );
  });

  it("never forces source=lease or the node stream label (the sequencer is not a lease stream)", () => {
    const q = scope();
    expect(q).not.toContain("source=");
    expect(q).not.toContain("node=");
  });

  it("keeps a bare caller pipeline AFTER the forced pin", () => {
    expect(scope('| json | step="proven"')).toBe(
      `${SELECTOR} ${PIN} | json | step="proven"`
    );
  });

  it("accepts a full selector, keeps narrowing labels and the pipeline after the pin", () => {
    expect(
      scope('{service="deploy", pod=~"operator-node-deploy-.*"} | step="alert"')
    ).toBe(
      `{env="production", service="sequencer", pod=~"operator-node-deploy-.*"} ${PIN} | step="alert"`
    );
  });

  it("accepts the stream name sequencer as an equal caller matcher", () => {
    expect(scope('{service="sequencer", env="production"}')).toBe(
      `${SELECTOR} ${PIN}`
    );
  });

  it.each([
    ["another service", '{service="app"}'],
    ["a regex widening of service", '{service=~".+"}'],
    ["a negated service", '{service!="deploy"}'],
    ["another env", '{service="deploy", env="preview"}'],
    ["a regex env", '{env=~".*"}'],
  ])("REJECTS %s", (_name, query) => {
    expect(() => scope(query)).toThrowError(
      expect.objectContaining({ code: "query_out_of_scope" })
    );
  });

  it("another node's events are UNREACHABLE: the pin precedes every caller stage and appears once", () => {
    const hostile = [
      `{service="deploy", nodeId="${OTHER}"}`,
      `{service="deploy", node="${OTHER}"}`,
      `| json | nodeId="${OTHER}"`,
      `| json | nodeId=~".*"`,
      `| json | nodeId=~"${OTHER}|${NODE}"`,
      `| label_format nodeId="${OTHER}"`,
      `|= "${OTHER}"`,
      `{service="deploy"} | json | nodeId!="${NODE}"`,
      `{service="deploy"} or {service="sequencer"}`,
    ];
    for (const query of hostile) {
      let scoped: string | undefined;
      try {
        scoped = scope(query);
      } catch (e) {
        // A refusal is also safe: nothing is queried.
        expect(e).toBeInstanceOf(ObservabilityQueryError);
        continue;
      }
      // The forced prefix is byte-identical, so every caller stage runs on already-pinned lines.
      expect(scoped.startsWith(`${SELECTOR.slice(0, -1)}`)).toBe(true);
      const pinAt = scoped.indexOf(PIN);
      expect(pinAt).toBeGreaterThan(0);
      expect(scoped.indexOf(PIN, pinAt + 1)).toBe(-1);
      // Nothing but the stream selector precedes the pin.
      const before = scoped.slice(0, pinAt);
      expect(before).toMatch(/^\{[^|]*\} $/);
    }
  });

  it("a bare pipeline cannot smuggle a stream block; a trailing block stays AFTER the pin (an unparseable query, never a wider one)", () => {
    expect(() => scope('|= "x" } | {service="app"')).toThrowError(
      expect.objectContaining({ code: "invalid_query" })
    );
    const trailing = scope('{service="deploy"} {env="preview"}');
    expect(trailing.startsWith(`${SELECTOR} ${PIN}`)).toBe(true);
  });

  it("escapes quotes/backslashes in the nodeId (no pin breakout)", () => {
    const q = scopeNodeLogQL({
      env: "production",
      nodeId: 'x" | json | nodeId=~".*',
      service: "deploy",
    });
    expect(q).toContain(String.raw`nodeId="x\" | json | nodeId=~\".*"`);
  });

  it("is not reachable by the lease-service path: a normal service still pins node+source", () => {
    expect(
      scopeNodeLogQL({ env: "production", nodeId: NODE, service: "web" })
    ).toBe(`{env="production", service="web", node="${NODE}", source="lease"}`);
    expect(
      scopeNodeLogQL({ env: "production", nodeId: NODE, service: "sequencer" })
    ).toBe(
      `{env="production", service="sequencer", node="${NODE}", source="lease"}`
    );
  });
});
