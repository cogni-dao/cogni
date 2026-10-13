// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/grafana-fleet-alerts`
 * Purpose: Pin the queryable fleet Serve-outage alert contract.
 * Scope: Static validation of the Grafana provisioning YAML. Does not access the network or Grafana.
 * Invariants:
 *   - SERVE_OUTAGE_IS_NODE_SCOPED: one alert instance is produced per environment/node.
 *   - REGIONAL_REDUNDANCY_IS_PRESERVED: one healthy probe keeps Serve healthy.
 *   - MISSING_EVIDENCE_FAILS_CLOSED: no-data and evaluation errors alert.
 *   - RULE_ORDER_IS_APPEND_ONLY: the newest rule remains last because Grafana rule groups
 *     are positional resources and inserting it earlier rewrites existing alert identities.
 * Side-effects: IO (reads committed YAML)
 * Links: bug.5459, infra/grafana/README.md,
 *   https://cognidao.org/knowledge/fleet-reliability-reconcile-guide
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const ALERTS_FILE = path.resolve(
  __dirname,
  "../../infra/grafana/alerts/fleet-capacity.alerts.yaml"
);
const SYNTHETIC_MAIN_FILE = path.resolve(
  __dirname,
  "../../infra/grafana/synthetic/main.tf"
);

interface AlertData {
  readonly refId: string;
  readonly model: {
    readonly expr?: string;
    readonly conditions?: ReadonlyArray<{
      readonly evaluator?: {
        readonly type?: string;
        readonly params?: number[];
      };
    }>;
  };
}

interface AlertRule {
  readonly uid: string;
  readonly title: string;
  readonly condition: string;
  readonly for: string;
  readonly data: readonly AlertData[];
  readonly labels: Readonly<Record<string, string>>;
  readonly noDataState: string;
  readonly execErrState: string;
}

interface AlertDocument {
  readonly groups: ReadonlyArray<{ readonly rules: readonly AlertRule[] }>;
}

const document = yaml.parse(readFileSync(ALERTS_FILE, "utf8")) as AlertDocument;
const rules = document.groups[0]?.rules ?? [];
const serveRule = rules.find((rule) => rule.uid === "fleet-serve-down");
const syntheticMain = readFileSync(SYNTHETIC_MAIN_FILE, "utf8");

describe("fleet Serve alert contract (bug.5459)", () => {
  it("defines exactly one append-only Serve rule", () => {
    expect(
      rules.filter((rule) => rule.uid === "fleet-serve-down")
    ).toHaveLength(1);
    expect(rules.at(-1)?.uid).toBe("fleet-serve-down");
  });

  it("alerts per node only when every independent probe reports failure", () => {
    expect(serveRule).toBeDefined();
    expect(serveRule?.data[0]?.model.expr).toBe(
      'max by (environment, node_slug) (probe_success{environment="__ENVIRONMENT__",proof_class="serve"})'
    );
    expect(serveRule?.data[1]?.model.conditions?.[0]?.evaluator).toEqual({
      type: "lt",
      params: [1],
    });
    expect(serveRule?.for).toBe("2m");
  });

  it("fails closed without enabling notification delivery", () => {
    expect(serveRule?.labels).toEqual({
      severity: "critical",
      proof_class: "serve",
    });
    expect(serveRule?.noDataState).toBe("Alerting");
    expect(serveRule?.execErrState).toBe("Alerting");
    expect(syntheticMain).toMatch(
      /notification_settings\s*{\s*contact_point\s*=\s*grafana_contact_point\.query_only\.name\s*mute_timings\s*=\s*\[grafana_mute_timing\.query_only\.name\]\s*}/
    );
  });
});
