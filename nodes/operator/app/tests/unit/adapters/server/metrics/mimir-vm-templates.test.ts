// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/metrics/mimir-vm-templates`
 * Purpose: Pins the governed vm_* metrics templates to the PromQL that scripts/vm-health-snapshot.mjs reads.
 * Scope: Pure template→PromQL map, CLI-text agreement fixture, and fail-closed queryTemplate paths. No real HTTP.
 * Invariants: ONE_HEALTH_CONTRACT (same series, policy selector, TTL, aggregation as the CLI); MISSING_IS_UNKNOWN.
 * Side-effects: none (reads the CLI source as text; mocked fetch)
 * Links: src/adapters/server/metrics/mimir.adapter.ts, scripts/vm-health-snapshot.mjs, story.5105
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELIABILITY_POLICY_V1 } from "@cogni/node-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTemplatePromQL,
  MimirMetricsAdapter,
  TemplateQueryError,
} from "@/adapters/server/metrics/mimir.adapter";
import type { MetricTemplate, TemplateQueryParams } from "@/ports";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../../../../..");
const CLI_SOURCE = readFileSync(
  path.join(REPO_ROOT, "scripts/vm-health-snapshot.mjs"),
  "utf8"
);

/** Literal query-building lines in the CLI source (JS template text, not ours). */
const CLI_TEXT = {
  policySelector:
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal CLI source text
    'policy: `environment="${env}",policy_version="${POLICY.version}"`',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal CLI source text
  fresh: "`(${sel} and (time() - timestamp(${sel}) <= ${TTL_SEC}))`",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal CLI source text
  swapIn: "one(`max(rate(node_vmstat_pswpin{${h}}[5m]))`)",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal CLI source text
  hostSelector: 'host: `env="${env}",substrate_host="${host}"`',
} as const;

const V = RELIABILITY_POLICY_V1.version;
const TTL = RELIABILITY_POLICY_V1.evidenceTtlMs / 1000;
const HOST = 'substrate_host=~"[0-9a-f]{32}"';

const vm = (
  template: MetricTemplate,
  environment: TemplateQueryParams["environment"] = "production"
): string =>
  buildTemplatePromQL({
    template,
    service: "ignored",
    environment,
    window: "5m",
  });

/** Policy signal key in the CLI ↔ governed template. */
const POLICY_SIGNALS = [
  ["vm_memory_headroom", "memoryHeadroomPercent"],
  ["vm_disk_headroom", "diskHeadroomPercent"],
  ["vm_io_pressure", "ioPressurePercent"],
] as const;

/** CLI's SIGNAL_SERIES map, read from its source text so drift fails here. */
function cliSignalSeries(key: string): string {
  const match = CLI_SOURCE.match(new RegExp(`${key}: "([a-z0-9_]+)"`));
  if (!match?.[1]) throw new Error(`CLI SIGNAL_SERIES lacks ${key}`);
  return match[1];
}

describe("vm_* template → PromQL map", () => {
  it("renders the exact production expressions", () => {
    const sel = (m: string) =>
      `${m}{environment="production",policy_version="${V}",${HOST}}`;
    const fresh = (s: string) =>
      `(${s} and (time() - timestamp(${s}) <= ${TTL}))`;
    expect(vm("vm_memory_headroom")).toBe(
      `min by (substrate_host) ${fresh(sel("cogni_reliability_v1_memory_headroom_percent"))}`
    );
    expect(vm("vm_disk_headroom")).toBe(
      `min by (substrate_host) ${fresh(sel("cogni_reliability_v1_disk_headroom_percent"))}`
    );
    expect(vm("vm_io_pressure")).toBe(
      `max by (substrate_host) ${fresh(sel("cogni_reliability_v1_io_pressure_percent"))}`
    );
    expect(vm("vm_swap_in")).toBe(
      `max by (substrate_host) (rate(node_vmstat_pswpin{env="production",${HOST}}[5m])) and on (substrate_host) count by (substrate_host) ${fresh(sel("cogni_reliability_v1_memory_headroom_percent"))}`
    );
  });

  it("scopes every vm template to the requested environment only", () => {
    for (const t of [
      "vm_memory_headroom",
      "vm_disk_headroom",
      "vm_io_pressure",
      "vm_swap_in",
    ] as const) {
      const q = vm(t, "candidate-a");
      expect(q).toContain('"candidate-a"');
      expect(q).not.toMatch(/"production"|"preview"/);
      expect(q).not.toContain("ignored");
    }
  });
});

describe("vm_* templates agree with scripts/vm-health-snapshot.mjs", () => {
  it.each(
    POLICY_SIGNALS
  )("%s reads the CLI's %s series, selector, TTL and policy-worst aggregation", (template, key) => {
    const q = vm(template);
    // Same series under the CLI's policy selector (`${metric}{${s.policy}`).
    expect(CLI_SOURCE).toContain(CLI_TEXT.policySelector);
    expect(q).toContain(
      `${cliSignalSeries(key)}{environment="production",policy_version="${V}"`
    );
    // Same freshness gate as the CLI's fresh() helper and evidenceTtlMs.
    expect(CLI_SOURCE).toContain(CLI_TEXT.fresh);
    expect(q).toContain(`<= ${TTL}))`);
    // Same 32-hex host identity the CLI's HOST_RE accepts.
    expect(CLI_SOURCE).toContain("const HOST_RE = /^[0-9a-f]{32}$/;");
    expect(q).toContain(HOST);
    // Policy-worst: CLI uses Math.min for "below" signals, Math.max for "above".
    const direction = RELIABILITY_POLICY_V1.signals[key].direction;
    expect(q.startsWith(direction === "below" ? "min by" : "max by")).toBe(
      true
    );
  });

  it("vm_swap_in is the CLI's swap-in rate on the attested host", () => {
    expect(CLI_SOURCE).toContain(CLI_TEXT.swapIn);
    expect(CLI_SOURCE).toContain(CLI_TEXT.hostSelector);
    expect(vm("vm_swap_in")).toContain(
      `max by (substrate_host) (rate(node_vmstat_pswpin{env="production",${HOST}}[5m]))`
    );
  });
});

describe("queryTemplate vm_* fail-closed paths", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let adapter: MimirMetricsAdapter;

  const matrix = (result: unknown[]) => ({
    ok: true,
    json: async () => ({
      status: "success",
      data: { resultType: "matrix", result },
    }),
  });

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as typeof fetch;
    adapter = new MimirMetricsAdapter({
      url: "https://mimir.example.com",
      username: "u",
      password: "p",
      timeoutMs: 1000,
    });
  });

  it("returns the single host value without a service allowlist match", async () => {
    mockFetch.mockResolvedValueOnce(
      matrix([
        {
          metric: { substrate_host: "48837aa82fdb4eb0aeb1a74123b0c201" },
          values: [
            [1000, "26.1"],
            [1015, "25.5"],
          ],
        },
      ])
    );
    const result = await adapter.queryTemplate({
      template: "vm_memory_headroom",
      service: "operator",
      environment: "candidate-a",
      window: "5m",
    });
    expect(result.summary.current).toBe(25.5);
    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get("query")).toBe(
      vm("vm_memory_headroom", "candidate-a")
    );
  });

  it("rejects local (no shared VM) without querying", async () => {
    await expect(
      adapter.queryTemplate({
        template: "vm_swap_in",
        service: "cogni-template",
        environment: "local",
        window: "5m",
      })
    ).rejects.toMatchObject({ code: "ENVIRONMENT_NOT_ALLOWED" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("reports missing evidence as NO_DATA, never 0", async () => {
    mockFetch.mockResolvedValueOnce(matrix([]));
    const error = await adapter
      .queryTemplate({
        template: "vm_disk_headroom",
        service: "cogni-template",
        environment: "production",
        window: "5m",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TemplateQueryError);
    expect((error as TemplateQueryError).code).toBe("NO_DATA");
  });

  it("fails closed when two substrate hosts report for one env", async () => {
    mockFetch.mockResolvedValueOnce(
      matrix([
        { metric: { substrate_host: "a".repeat(32) }, values: [[1, "1"]] },
        { metric: { substrate_host: "b".repeat(32) }, values: [[1, "2"]] },
      ])
    );
    await expect(
      adapter.queryTemplate({
        template: "vm_io_pressure",
        service: "cogni-template",
        environment: "production",
        window: "5m",
      })
    ).rejects.toMatchObject({ code: "MULTI_SERIES_RESULT" });
  });
});
