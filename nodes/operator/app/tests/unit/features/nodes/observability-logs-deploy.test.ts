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
      `${SELECTOR} ${PIN} | json | step="proven" | nodeId="${NODE}"`
    );
  });

  it("accepts a full selector, keeps narrowing labels and the pipeline after the pin", () => {
    expect(
      scope('{service="deploy", pod=~"operator-node-deploy-.*"} | step="alert"')
    ).toBe(
      `{env="production", service="sequencer", pod=~"operator-node-deploy-.*"} ${PIN} | step="alert" | nodeId="${NODE}"`
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

  // The query a node dev sends must only ever return that node's lines. A scoped query is SAFE when it
  // is refused (400) or when, with string literals blanked, it is exactly: the stream selector, the
  // forced pin, the caller's whole stages (no top-level or/and/unless, no braces), and the closing
  // `| nodeId="<id>"` pin as the LAST stage.
  const blank = (q: string): string => q.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const assertOnlyThisNode = (query: string): "refused" | "scoped" => {
    let scoped: string;
    try {
      scoped = scope(query);
    } catch (e) {
      expect(e).toBeInstanceOf(ObservabilityQueryError);
      expect((e as ObservabilityQueryError).code).toMatch(
        /invalid_query|query_out_of_scope/
      );
      return "refused";
    }
    expect(scoped.startsWith(`${SELECTOR.slice(0, -1)}`)).toBe(true);
    const pinAt = scoped.indexOf(PIN);
    expect(pinAt).toBeGreaterThan(0);
    expect(scoped.indexOf(PIN, pinAt + 1)).toBe(-1);
    expect(scoped.slice(0, pinAt)).toMatch(/^\{[^|]*\} $/);
    // the caller's part is whole stages and cannot widen the filters around it
    const caller = scoped.slice(pinAt + PIN.length);
    if (caller !== "") {
      expect(caller.endsWith(` | nodeId="${NODE}"`)).toBe(true);
      expect(blank(caller)).toMatch(/^ (\||!=|!~)/);
      expect(blank(caller)).not.toMatch(/\b(or|and|unless)\b/i);
      expect(blank(caller)).not.toMatch(/[{}]/);
    }
    return "scoped";
  };

  it.each([
    // or / and, bare and selector forms (the reviewer's proven leak)
    'or nodeId=~".+"',
    `or nodeId="${OTHER}"`,
    'and nodeId=~".+"',
    `{service="deploy"} or nodeId="${OTHER}"`,
    '{service="deploy"} or nodeId=~".+"',
    '{service="deploy"} and nodeId=~".+"',
    '{service="deploy"} unless nodeId="x"',
    '| json | step="a" or nodeId=~".+"',
    `| json | step="a" OR nodeId="${OTHER}"`,
    '| (step="a") or (nodeId=~".+")',
    // a remainder that is not whole stages
    '{service="deploy"} nodeId=~".+"',
    '{service="deploy"} {env="preview"}',
    '| json } or {service="app"',
    '| json) or (nodeId=~".+"',
    // label rewrites of the pinned labels
    `| label_format nodeId="${OTHER}"`,
    "| label_format nodeId=reason",
    '| label_format foo=bar, node="x"',
    '{service="deploy"} | label_format env="x"',
    '| label_format service="app"',
    // an unterminated string cannot swallow the closing pin
    '| json | reason="oops',
  ])("REJECTS %s", (query) => {
    expect(assertOnlyThisNode(query)).toBe("refused");
  });

  it.each([
    // legitimate narrowing stays allowed, and the closing pin is the last stage
    '| json | step="proven"',
    '|= "alert" != "debug"',
    '{service="deploy", pod=~"operator-node-deploy-.*"} | json | step="alert"',
    // regex / negated nodeId matchers are ANDed with the pins: they can only narrow
    '| json | nodeId=~".+"',
    `| json | nodeId=~"${OTHER}|${NODE}"`,
    `| json | nodeId!="${NODE}"`,
    `| json | nodeId="${OTHER}"`,
    `{service="deploy", nodeId="${OTHER}"}`,
    `{service="deploy", node="${OTHER}"}`,
    // a label READ into a non-protected label
    "| label_format other=nodeId",
    // unwrap (metric stage): the closing pin still follows, never precedes
    "| json | unwrap elapsedMs",
    // quoted keywords and braces are text, not operators
    '{service="deploy"} |= "this or that and {braces}"',
    '{service="deploy"} | line_format "{{.step}} or {{.outcome}}"',
  ])("keeps %s scoped: only this node's lines can match", (query) => {
    expect(assertOnlyThisNode(query)).toBe("scoped");
  });

  it("sandwiches the caller's stages between the forced pin and a closing pin (final query string)", () => {
    expect(scope('| json | nodeId=~".+"')).toBe(
      `${SELECTOR} ${PIN} | json | nodeId=~".+" | nodeId="${NODE}"`
    );
    expect(scope('{service="deploy"} | json | unwrap elapsedMs')).toBe(
      `${SELECTOR} ${PIN} | json | unwrap elapsedMs | nodeId="${NODE}"`
    );
    // no caller stages: the forced pin is already the last stage, nothing is repeated
    expect(scope()).toBe(`${SELECTOR} ${PIN}`);
    expect(scope('{service="deploy"}')).toBe(`${SELECTOR} ${PIN}`);
  });

  it("a bare pipeline cannot smuggle a stream block", () => {
    expect(() => scope('|= "x" } | {service="app"')).toThrowError(
      expect.objectContaining({ code: "invalid_query" })
    );
  });

  it("the stream-pinned scopes (app, lease) refuse the same payloads and keep narrowing stages", () => {
    for (const service of [undefined, "web"]) {
      for (const query of [
        'or node=~".+"',
        '{service="app"} or node="x"',
        '| json | level="x" or node=~".+"',
        "| label_format node=other",
        '| label_format nodeId="x"',
      ]) {
        expect(() =>
          scopeNodeLogQL({ env: "production", nodeId: NODE, service, query })
        ).toThrowError(
          expect.objectContaining({
            code: expect.stringMatching(/invalid_query|query_out_of_scope/),
          })
        );
      }
      // the selector is the pin there: no closing pin, output unchanged
      expect(
        scopeNodeLogQL({
          env: "production",
          nodeId: NODE,
          service,
          query: '| json | level="error"',
        })
      ).toMatch(
        /^\{env="production", service="[a-z]+", node="[^"]+"(, source="lease")?\} \| json \| level="error"$/
      );
    }
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
