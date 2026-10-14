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
const CAPACITY_DASHBOARD_FILE = path.resolve(
  __dirname,
  "../../infra/grafana/dashboards/operator/fleet-capacity.json"
);
const RUNTIME_POLICY_FILE = path.resolve(
  __dirname,
  "../../infra/k8s/base/database-reliability-actuator/deployment.yaml"
);
const PREVIEW_OVERLAY_FILE = path.resolve(
  __dirname,
  "../../infra/k8s/overlays/preview/operator/kustomization.yaml"
);
const CANDIDATE_FLIGHT_FILE = path.resolve(
  __dirname,
  "../../.github/workflows/candidate-flight.yml"
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
const capacityDashboard = readFileSync(CAPACITY_DASHBOARD_FILE, "utf8");
const HISTORICAL_UID_PREFIX = [
  "fleet-telemetry-deadman",
  "fleet-memory-headroom",
  "fleet-disk-headroom",
  "fleet-inode-headroom",
  "fleet-io-pressure",
  "fleet-container-oom",
  "fleet-postgres-down",
  "fleet-postgres-connections",
  "fleet-postgres-temp-io",
  "fleet-backup-freshness",
  "fleet-serve-down",
] as const;

describe("fleet Serve alert contract (bug.5459)", () => {
  it("preserves the complete historical UID prefix and appends new rules", () => {
    expect(
      rules.filter((rule) => rule.uid === "fleet-serve-down")
    ).toHaveLength(1);
    expect(
      rules.slice(0, HISTORICAL_UID_PREFIX.length).map((rule) => rule.uid)
    ).toEqual(HISTORICAL_UID_PREFIX);
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

  it("records one versioned percent contract consumed by alerts and dashboard", () => {
    for (const metric of [
      "cogni_reliability_v1_io_pressure_percent",
      "cogni_reliability_v1_connections_percent",
      "cogni_reliability_v1_memory_headroom_percent",
      "cogni_reliability_v1_disk_headroom_percent",
      "cogni_reliability_v1_database_backends_share_percent",
      "cogni_reliability_v1_database_physical_reads_share_percent",
      "cogni_reliability_v1_database_temp_bytes_share_percent",
    ]) {
      expect(syntheticMain).toContain(metric);
    }
    expect(syntheticMain).toContain('policy_version = "reliability-status-v1"');
    for (const uid of [
      "reliability-io-warning",
      "reliability-connections-warning",
      "reliability-memory-warning",
      "reliability-disk-warning",
    ]) {
      expect(syntheticMain).toContain(uid);
    }
    expect(syntheticMain).toContain(
      'config_json = file("${path.module}/../dashboards/operator/fleet-capacity.json")'
    );
    expect(capacityDashboard).toContain(
      "feature.node_reliability_status.complete"
    );
    expect(capacityDashboard).toContain(
      "cogni_reliability_v1_database_backends_share_percent"
    );
  });

  it("keeps the private actuator network and credential boundary narrow", () => {
    const resources = yaml
      .parseAllDocuments(readFileSync(RUNTIME_POLICY_FILE, "utf8"))
      .map((document) => document.toJSON());
    const actuatorPolicy = resources.find(
      (resource) =>
        resource.kind === "NetworkPolicy" &&
        resource.metadata.name === "database-reliability-actuator"
    );
    const readmitterPolicy = resources.find(
      (resource) =>
        resource.kind === "NetworkPolicy" &&
        resource.metadata.name === "database-reliability-readmitter"
    );
    expect(actuatorPolicy.spec.ingress).toEqual([
      expect.objectContaining({
        from: [
          {
            podSelector: {
              matchLabels: { "app.kubernetes.io/name": "node-app" },
            },
          },
          {
            podSelector: {
              matchLabels: {
                "app.kubernetes.io/name": "database-reliability-readmitter",
              },
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 8080 }],
      }),
    ]);
    expect(readmitterPolicy.spec.ingress).toEqual([
      expect.objectContaining({
        from: [
          {
            podSelector: {
              matchLabels: { "app.kubernetes.io/name": "node-app" },
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 8081 }],
      }),
    ]);
    const deployment = readFileSync(
      path.resolve(
        __dirname,
        "../../infra/k8s/base/database-reliability-actuator/deployment.yaml"
      ),
      "utf8"
    );
    expect(deployment).not.toContain("GH_REVIEW_APP");
    const sweep = resources.find(
      (resource) =>
        resource.kind === "Deployment" &&
        resource.metadata.name === "database-reliability-actuator"
    );
    const readmitter = resources.find(
      (resource) =>
        resource.kind === "Deployment" &&
        resource.metadata.name === "database-reliability-readmitter"
    );
    const serializedSweep = JSON.stringify(sweep);
    const serializedReadmitter = JSON.stringify(readmitter);
    expect(serializedSweep).toContain("DATABASE_RELIABILITY_ADMIN_URL");
    expect(serializedSweep).not.toContain("DATABASE_RELIABILITY_READMIT_URL");
    expect(serializedSweep).not.toContain("DATABASE_RELIABILITY_READMIT_TOKEN");
    expect(serializedReadmitter).toContain("DATABASE_RELIABILITY_READMIT_URL");
    expect(serializedReadmitter).toContain(
      "DATABASE_RELIABILITY_READMIT_TOKEN"
    );
    expect(serializedReadmitter).not.toContain(
      "DATABASE_RELIABILITY_ADMIN_URL"
    );
    expect(serializedReadmitter).not.toContain("GRAFANA_SERVICE_ACCOUNT_TOKEN");
    for (const environment of ["candidate-a", "preview", "production"]) {
      const externalSecret = readFileSync(
        path.resolve(
          __dirname,
          `../../infra/k8s/overlays/${environment}/operator/database-reliability-actuator-external-secret.yaml`
        ),
        "utf8"
      );
      expect(externalSecret).not.toContain("GH_REVIEW_APP");
    }
  });

  it("derives preview probes from the cognidao.org fleet root", () => {
    const previewOverlay = readFileSync(PREVIEW_OVERLAY_FILE, "utf8");
    expect(previewOverlay).not.toMatch(
      /name: FORK_DOMAIN_ROOT\s+value: cogni-testing\.org/
    );
    expect(
      previewOverlay.match(/name: FORK_DOMAIN_ROOT\s+value: cognidao\.org/g)
    ).toHaveLength(2);
  });

  it("gates reliability runtime only after promotion and exact-SHA proof", () => {
    const workflow = readFileSync(CANDIDATE_FLIGHT_FILE, "utf8");
    const preflight = workflow.indexOf("- name: Assert target substrate");
    const preflightMarker = workflow.indexOf(
      "- name: Emit per-node assert marker"
    );
    const exactSha = workflow.indexOf(
      "- name: Verify buildSha on endpoint (per-node)"
    );
    const runtime = workflow.indexOf(
      "- name: Assert promoted database reliability runtime"
    );
    const smoke = workflow.indexOf(
      "- name: Run candidate smoke checks (per-node)"
    );
    expect(preflight).toBeGreaterThan(-1);
    expect(preflightMarker).toBeGreaterThan(preflight);
    expect(exactSha).toBeGreaterThan(preflightMarker);
    expect(runtime).toBeGreaterThan(exactSha);
    expect(smoke).toBeGreaterThan(runtime);
    expect(workflow.slice(preflight, preflightMarker)).toContain(
      'ASSERT_DATABASE_RELIABILITY_RUNTIME: "false"'
    );
    expect(workflow.slice(runtime, smoke)).toContain(
      'ASSERT_DATABASE_RELIABILITY_RUNTIME: "true"'
    );
  });
});
