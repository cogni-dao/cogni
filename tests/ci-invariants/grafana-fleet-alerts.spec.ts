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

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";
import {
  loadSecretsCatalog,
  openBaoPathFor,
} from "../../scripts/lib/secrets-catalog-loader";

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
const CANDIDATE_FLIGHT_FILE = path.resolve(
  __dirname,
  "../../.github/workflows/candidate-flight.yml"
);
const SHARED_CONTAINMENT_REPLAY_FILE = path.resolve(
  __dirname,
  "../../scripts/ops/replay-shared-database-containment.sh"
);
const RELIABILITY_ACTUATOR_FILE = path.resolve(
  __dirname,
  "../../nodes/operator/app/src/bootstrap/database-reliability-actuator.ts"
);
const TARGET_SUBSTRATE_ASSERT_FILE = path.resolve(
  __dirname,
  "../../scripts/ci/assert-target-substrate.sh"
);
const IMAGE_TAGS_LIB_FILE = path.resolve(
  __dirname,
  "../../scripts/ci/lib/image-tags.sh"
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
  it("resolves private telemetry credentials from their canonical shared bank", () => {
    const repoRoot = path.resolve(__dirname, "../..");
    const catalog = loadSecretsCatalog({ repoRoot });
    for (const environment of ["candidate-a", "preview", "production"]) {
      const resources = yaml
        .parseAllDocuments(
          readFileSync(
            path.join(
              repoRoot,
              "infra/k8s/overlays",
              environment,
              "operator/database-reliability-actuator-external-secret.yaml"
            ),
            "utf8"
          )
        )
        .map((document) => document.toJSON());
      for (const resource of resources) {
        for (const key of [
          "PROMETHEUS_READ_USERNAME",
          "PROMETHEUS_READ_PASSWORD",
        ]) {
          const routing = catalog.routing[key];
          if (!routing) throw new Error("canonical telemetry routing missing");
          const expected = openBaoPathFor(routing, key, "operator", environment)
            ?.replace(/^cogni\//, "")
            .slice(0, -key.length - 1);
          expect(expected).toBe(`${environment}/_shared`);
          expect(
            resource.spec.data.find(
              (entry: { secretKey: string }) => entry.secretKey === key
            ).remoteRef
          ).toEqual({ key: expected, property: key });
        }
        const grafana = resource.spec.data.find(
          (entry: { secretKey: string }) =>
            entry.secretKey === "GRAFANA_SERVICE_ACCOUNT_TOKEN"
        );
        if (grafana)
          expect(grafana.remoteRef.key).toBe(`${environment}/operator`);
      }
    }
  });

  it("keeps the recovery watchdog independent and validates regional response identity", () => {
    const watchdogResources = yaml
      .parseAllDocuments(
        readFileSync(
          path.resolve(
            __dirname,
            "../../infra/k8s/base/database-reliability-actuator/watchdog.yaml"
          ),
          "utf8"
        )
      )
      .map((document) => document.toJSON());
    const watchdog = watchdogResources.find(
      (resource) => resource.kind === "Deployment"
    );
    const container = watchdog.spec.template.spec.containers[0];
    expect(watchdog.spec.replicas).toBe(2);
    expect(container.env).toContainEqual({
      name: "DATABASE_RELIABILITY_MODE",
      value: "watchdog",
    });
    expect(
      container.env.map((row: { name: string }) => row.name)
    ).not.toContain("PROMETHEUS_QUERY_URL");
    expect(
      watchdog.spec.template.spec.volumes[0].projected.sources[0].secret.items
    ).toEqual([
      {
        key: "DATABASE_RELIABILITY_ADMIN_URL",
        path: "DATABASE_RELIABILITY_ADMIN_URL",
      },
    ]);
    const source = readFileSync(RELIABILITY_ACTUATOR_FILE, "utf8");
    expect(source.indexOf('if (mode === "watchdog")')).toBeLessThan(
      source.indexOf("await resolveReliabilityController()")
    );
    const recoveryChecks = syntheticMain.slice(
      syntheticMain.indexOf(
        'resource "grafana_synthetic_monitoring_check" "database_recovery"'
      )
    );
    expect(recoveryChecks).toContain(
      "local.reliability_policy.expectedRegions"
    );
    expect(recoveryChecks).toContain("fail_if_body_not_matches_regexp");
    for (const identity of [
      "buildSha",
      "databaseSystemIdentifier",
      "proofClass",
      "incidentId",
    ])
      expect(recoveryChecks).toContain(identity);
  });

  it("bounds new Grafana UIDs without changing valid existing identities", () => {
    const warningBlock = syntheticMain.slice(
      syntheticMain.indexOf("for_each = local.reliability_warning_rules")
    );
    expect(warningBlock).toContain(
      'uid = length("${rule.value.uid}-${each.value.uid_suffix}") <= 40'
    );
    expect(syntheticMain).toContain(
      'length("${rule.value.uid}-${each.value.uid_suffix}") <= 40'
    );
    expect(syntheticMain).toContain(
      'substr("${rule.value.uid}-${each.value.uid_suffix}", 0, 26)'
    );
    expect(syntheticMain).toContain(
      'substr(sha256("${rule.value.uid}-${each.value.uid_suffix}"), 0, 12)'
    );
    const prefixes = [
      ...syntheticMain.matchAll(/uid\s*=\s*"(reliability-[^"]+-warning)"/g),
    ].map((match) => match[1]);
    expect(prefixes).toHaveLength(4);
    const identities = prefixes.flatMap((prefix) =>
      ["candidate-a", "preview", "production"].map((environment) => {
        const full = `${prefix}-${environment}`;
        const bounded =
          full.length <= 40
            ? full
            : `${full.slice(0, 26)}-${createHash("sha256").update(full).digest("hex").slice(0, 12)}`;
        expect(bounded.length).toBeLessThanOrEqual(40);
        if (full.length <= 40) expect(bounded).toBe(full);
        return bounded;
      })
    );
    expect(new Set(identities).size).toBe(12);
  });

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
    // node_exporter waiting is PSI Some; stalled is the canonical PSI Full counter.
    expect(syntheticMain).toContain(
      "rate(node_pressure_io_stalled_seconds_total"
    );
    expect(syntheticMain).not.toContain(
      "rate(node_pressure_io_waiting_seconds_total"
    );
    expect(
      readFileSync(
        path.resolve(
          __dirname,
          "../../infra/compose/runtime/configs/alloy-config.metrics.alloy"
        ),
        "utf8"
      )
    ).toContain("|node_pressure_io_stalled_seconds_total|");
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
    expect(sweep.spec.template.spec.volumes).toEqual([
      {
        name: "credentials",
        projected: {
          sources: [
            {
              secret: {
                name: "database-reliability-actuator-env-secrets",
                optional: true,
              },
            },
          ],
        },
      },
    ]);
    expect(readmitter.spec.template.spec.volumes).toEqual([
      {
        name: "credentials",
        projected: {
          sources: [
            {
              secret: {
                name: "database-reliability-readmitter-env-secrets",
                optional: true,
              },
            },
          ],
        },
      },
    ]);
    expect(serializedSweep).not.toContain(
      "database-reliability-readmitter-env-secrets"
    );
    expect(serializedReadmitter).not.toContain(
      "database-reliability-actuator-env-secrets"
    );
    for (const environment of ["candidate-a", "preview", "production"]) {
      const externalSecret = readFileSync(
        path.resolve(
          __dirname,
          `../../infra/k8s/overlays/${environment}/operator/database-reliability-actuator-external-secret.yaml`
        ),
        "utf8"
      );
      expect(externalSecret).not.toContain("GH_REVIEW_APP");
      const serviceSecrets = yaml
        .parseAllDocuments(externalSecret)
        .map((document) => document.toJSON());
      for (const secret of serviceSecrets) {
        const component = secret.metadata.labels["app.kubernetes.io/component"];
        expect(secret.spec.dataFrom).toEqual([
          { extract: { key: `${environment}/${component}` } },
        ]);
        expect(
          secret.spec.data.every(
            (entry: { remoteRef: { key: string } }) =>
              entry.remoteRef.key !== `${environment}/${component}`
          )
        ).toBe(true);
      }
    }
  });

  it("derives private controls from the verified cognidao.org fleet root", () => {
    for (const environment of ["candidate-a", "preview"]) {
      const overlay = readFileSync(
        path.resolve(
          __dirname,
          `../../infra/k8s/overlays/${environment}/operator/kustomization.yaml`
        ),
        "utf8"
      );
      expect(
        overlay.match(/name: FORK_DOMAIN_ROOT\s+value: cognidao\.org/g)
      ).toHaveLength(2);
    }
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
    expect(workflow.slice(runtime, smoke)).toContain(
      ".reliability.controller // false"
    );
    expect(workflow).not.toContain("matrix.node == 'operator'");
  });

  it("derives reliability controller and replay roles without node-name behavior", () => {
    const replay = readFileSync(SHARED_CONTAINMENT_REPLAY_FILE, "utf8");
    const actuator = readFileSync(RELIABILITY_ACTUATOR_FILE, "utf8");
    const substrateAssert = readFileSync(TARGET_SUBSTRATE_ASSERT_FILE, "utf8");
    const workflow = readFileSync(CANDIDATE_FLIGHT_FILE, "utf8");
    const productionSources = [replay, actuator, substrateAssert, workflow];

    for (const source of productionSources) {
      expect(source).not.toMatch(
        /node\.slug === ["'](?:operator|red|poly)["']/
      );
      expect(source).not.toMatch(
        /matrix\.node == ["'](?:operator|red|poly)["']/
      );
      expect(source).not.toMatch(
        /\[\s*["']\$node["']\s*=\s*["']?(?:operator|red|poly)["']?\s*\]/
      );
      expect(source).not.toMatch(
        /primarySlug:\s*["'](?:operator|red|poly)["']/
      );
      expect(source).not.toMatch(
        /node_slug["'],\s*["'](?:operator|red|poly)["']/
      );
      expect(source).not.toMatch(/infra\/catalog\/(?:operator|red|poly)\.yaml/);
      expect(source).not.toMatch(
        /https:\/\/(?:red|poly)?-?test\.cognidao\.org/
      );
    }

    expect(actuator).toContain("ReliabilityControllerCatalogSchema");
    expect(actuator).toContain("reliability_catalog_controller_not_unique");
    expect(actuator).toContain(
      "`/app/${controller.pathPrefix}.cogni/repo-spec.yaml`"
    );
    expect(substrateAssert).toContain(
      "reliability_controller=\"$(yq -N '.reliability.controller // false'"
    );
    expect(replay).toContain("catalog_for_role shared-target");
    expect(replay).toContain("catalog_for_role shared-control");
    expect(replay).not.toContain("catalog_for_role dedicated-neighbor");
    expect(replay).toContain("actualDeployedBuildSha");
    expect(replay).toContain("firstQualifyingRecordedAtEpoch");
    expect(replay).toContain("maximumContainmentSeconds:60");
    expect(replay).toContain(".transitionApplied == true");
    expect(replay).toContain("timestamp(${io_metric})");
    expect(replay).toContain('neighbor_shas=("$control_baseline_sha")');
    expect(replay).toContain("catalog_for_controller");
    expect(replay).toContain(
      'git -C "$root_dir" archive "$PLATFORM_BUILD_SHA"'
    );
    expect(replay).toContain(
      'git -C "$root_dir" show "${PLATFORM_BUILD_SHA}:${spec_path}"'
    );
    expect(replay).toContain("CONTROLLER_NODE_SLUG CONTROLLER_NODE_ID");
    expect(replay).not.toContain("TARGET_DATABASE_DSN");
    expect(replay).not.toContain("REGIONAL_BASE_URLS");
    expect(replay).not.toContain("NEIGHBOR_READYZ_URLS");
    expect(replay).toContain("role=candidate-a-db-reader");
    expect(replay).toContain(
      '"cogni/${DEPLOY_ENVIRONMENT}/${TARGET_NODE_SLUG}"'
    );
    expect(replay).toContain("export PGDATABASE");
    expect(replay).toContain(".expectedRegions[]");
    expect(replay).toContain('node_slug="%s",proof_class="serve"');
    expect(replay).toContain(
      'status=$(curl -fsS --max-time 10 -H "Cookie: $RELIABILITY_STATUS_COOKIE_HEADER" "$reliability_status_url")'
    );
    expect(replay).toContain(
      'target_before=$(actuator_get "$target_containment_status_path")'
    );
    expect(replay).toContain("configuredOrigin !== expectedOrigin || !token");
    expect(replay).not.toContain(': "${RELIABILITY_STATUS_URL:');
    expect(replay).not.toContain(': "${ACTUATOR_STATUS_BASE_URL:');
    expect(replay).not.toContain(': "${ACTUATOR_VERSION_URL:');
    expect(replay).not.toContain(': "${RELIABILITY_READMIT_URL:');
    expect(replay).toContain('-H "Cookie: $RELIABILITY_STATUS_COOKIE_HEADER"');
    expect(replay).not.toContain("RELIABILITY_READMIT_AUTH_HEADER");
    expect(replay).toContain(
      'nodeId=\\"$TARGET_NODE_ID\\" | environment=\\"candidate-a\\" | incidentId=\\"$incident_id\\"'
    );
    expect(replay).not.toContain("verify_readmission_window");
    expect(replay).not.toContain("-X POST");
    expect(replay).toContain('runtimeState:"NOLOGIN"');
    expect(replay).toContain("core_neighbor_sample");
    expect(replay).toContain("describeNamespace");
    expect(replay).toContain("describeTaskQueue");
    expect(replay).toContain("/v1/internal/substrate?environment=");
    expect(replay).not.toContain("DATABASE_RECOVERY_PROBE_URLS_JSON");

    const runProductionPlanner = (names: {
      readonly target: string;
      readonly controller: string;
      readonly dedicated: string;
      readonly clients?: string;
      readonly foreignDatabase?: boolean;
      readonly poisonedDsn?: boolean;
      readonly poisonedQuery?: boolean;
      readonly phase?: string;
    }) => {
      const fixtureRoot = mkdtempSync(
        path.join(tmpdir(), "reliability-replay-plan-")
      );
      try {
        mkdirSync(path.join(fixtureRoot, "infra/catalog"), {
          recursive: true,
        });
        mkdirSync(path.join(fixtureRoot, "packages/node-contracts/src"), {
          recursive: true,
        });
        mkdirSync(path.join(fixtureRoot, "scripts/ci/lib"), {
          recursive: true,
        });
        mkdirSync(path.join(fixtureRoot, "scripts/ops"), { recursive: true });
        writeFileSync(
          path.join(fixtureRoot, "infra/database-budget-profiles.yaml"),
          yaml.stringify({
            "shared-default-v1": { roles: { app: { connection_limit: 2 } } },
          })
        );
        copyFileSync(
          SHARED_CONTAINMENT_REPLAY_FILE,
          path.join(
            fixtureRoot,
            "scripts/ops/replay-shared-database-containment.sh"
          )
        );
        copyFileSync(
          IMAGE_TAGS_LIB_FILE,
          path.join(fixtureRoot, "scripts/ci/lib/image-tags.sh")
        );
        for (const name of ["appset-paths.sh", "lane-db-residency.sh"]) {
          copyFileSync(
            path.resolve(__dirname, `../../scripts/ci/lib/${name}`),
            path.join(fixtureRoot, `scripts/ci/lib/${name}`)
          );
        }
        mkdirSync(path.join(fixtureRoot, "scripts/setup/lib"), {
          recursive: true,
        });
        copyFileSync(
          path.resolve(
            __dirname,
            "../../scripts/setup/lib/cogni-deployment-identity.sh"
          ),
          path.join(
            fixtureRoot,
            "scripts/setup/lib/cogni-deployment-identity.sh"
          )
        );
        writeFileSync(
          path.join(
            fixtureRoot,
            "packages/node-contracts/src/reliability-policy.v1.json"
          ),
          JSON.stringify({
            expectedRegions: ["Frankfurt", "Ohio"],
            noisyNeighborSharePercent: 40,
          })
        );
        const rows = [
          {
            name: names.target,
            type: "node",
            node_id: "10000000-0000-4000-8000-000000000001",
            envs: ["candidate-a"],
            database: {
              "candidate-a": {
                tier: "shared",
                budget_profile: "shared-default-v1",
              },
            },
            reliability_validation: {
              "candidate-a": { role: "shared-target" },
            },
            ...(names.foreignDatabase
              ? { deployment_provider: { "candidate-a": "akash" } }
              : {}),
          },
          {
            name: names.controller,
            type: "node",
            node_id: "20000000-0000-4000-8000-000000000002",
            envs: ["candidate-a"],
            is_primary_host: true,
            database: {
              "candidate-a": {
                tier: "shared",
                budget_profile: "shared-default-v1",
              },
            },
            reliability: { controller: true },
            reliability_validation: {
              "candidate-a": { role: "shared-control" },
            },
          },
          {
            name: names.dedicated,
            type: "node",
            node_id: "30000000-0000-4000-8000-000000000003",
            envs: ["candidate-a"],
            database: {
              "candidate-a": {
                tier: "dedicated",
                budget_profile: "dedicated-high-throughput-v1",
              },
            },
            reliability_validation: {
              "candidate-a": { role: "dedicated-neighbor" },
            },
          },
        ];
        for (const row of rows) {
          writeFileSync(
            path.join(fixtureRoot, `infra/catalog/${row.name}.yaml`),
            yaml.stringify(row)
          );
        }
        execFileSync("git", ["init", "-q"], { cwd: fixtureRoot });
        execFileSync("git", ["config", "user.email", "fixture@example.test"], {
          cwd: fixtureRoot,
        });
        execFileSync("git", ["config", "user.name", "Fixture"], {
          cwd: fixtureRoot,
        });
        execFileSync("git", ["add", "."], { cwd: fixtureRoot });
        execFileSync("git", ["commit", "-qm", "fixture"], {
          cwd: fixtureRoot,
        });
        const sha = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: fixtureRoot,
          encoding: "utf8",
        }).trim();
        const fakeBin = path.join(fixtureRoot, "fake-bin");
        const sqlMarker = path.join(fixtureRoot, "sql-started");
        if (names.poisonedDsn || names.poisonedQuery) {
          mkdirSync(fakeBin);
          writeFileSync(
            path.join(fakeBin, "kubectl"),
            `#!/usr/bin/env bash
case "$*" in
  *"get serviceaccount"*) exit 0 ;;
  *"create token"*) printf 'fixture-jwt' ;;
  *"bao write -field=token"*) printf 'fixture-token' ;;
  *"bao kv get"*) printf '%s' '{"data":{"data":{"DATABASE_URL":"postgresql://app_${names.target}:fixture@${names.poisonedQuery ? "candidate-a.vm.example.invalid" : "foreign.example.invalid"}:5432/cogni_${names.target}${names.poisonedQuery ? "?host=foreign.example.invalid" : ""}"}}}' ;;
  *) exit 98 ;;
esac
`,
            { mode: 0o700 }
          );
          for (const command of ["psql", "pgbench"]) {
            writeFileSync(
              path.join(fakeBin, command),
              `#!/usr/bin/env bash\ntouch '${sqlMarker}'\nexit 99\n`,
              { mode: 0o700 }
            );
          }
        }
        // Poison mutable worktree inputs after the commit. The production
        // planner must still read catalog + policy from PLATFORM_BUILD_SHA.
        writeFileSync(
          path.join(fixtureRoot, `infra/catalog/${names.target}.yaml`),
          yaml.stringify({ name: "worktree-poison", type: "infra" })
        );
        writeFileSync(
          path.join(fixtureRoot, "infra/database-budget-profiles.yaml"),
          yaml.stringify({
            "shared-default-v1": { roles: { app: { connection_limit: 99 } } },
          })
        );
        writeFileSync(
          path.join(
            fixtureRoot,
            "packages/node-contracts/src/reliability-policy.v1.json"
          ),
          JSON.stringify({
            expectedRegions: ["mutable"],
            noisyNeighborSharePercent: 99,
          })
        );
        const result = spawnSync(
          "bash",
          ["scripts/ops/replay-shared-database-containment.sh"],
          {
            cwd: fixtureRoot,
            encoding: "utf8",
            env: {
              PATH: `${fakeBin}:${process.env.PATH}`,
              ALLOW_CANDIDATE_DATABASE_REPLAY: "1",
              DEPLOY_ENVIRONMENT: "candidate-a",
              PLATFORM_BUILD_SHA: sha,
              CANDIDATE_DOMAIN: "test.example.invalid",
              FORK_DOMAIN_ROOT: "example.invalid",
              REPLAY_PLAN_ONLY:
                names.poisonedDsn || names.poisonedQuery ? "0" : "1",
              ...(names.phase ? { REPLAY_PHASE: names.phase } : {}),
              ...(names.poisonedDsn || names.poisonedQuery
                ? {
                    RELIABILITY_STATUS_COOKIE_HEADER: "fixture-session",
                    MIMIR_QUERY_URL: "https://metrics.example.invalid",
                    METRICS_AUTH_HEADER: "fixture",
                    LOKI_QUERY_URL: "https://logs.example.invalid",
                    LOKI_AUTH_HEADER: "fixture",
                    INCIDENT_REQUEST_RATE: "1",
                  }
                : {}),
              ...(names.clients ? { REPLAY_CLIENTS: names.clients } : {}),
            },
          }
        );
        if (names.poisonedDsn || names.poisonedQuery)
          expect(existsSync(sqlMarker)).toBe(false);
        if (result.status !== 0) throw new Error(result.stderr);
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        return JSON.parse(result.stdout) as {
          platformBuildSha: string;
          load: {
            budgetProfile: string;
            appConnectionLimit: number;
            clients: number;
          };
          controller: {
            slug: string;
            buildSha: string;
            publicBase: string;
            versionUrl: string;
            actuator: {
              origin: string;
              statusPath: string;
              versionUrl: string;
            };
            readmitter: { origin: string };
          };
          validation: {
            sharedTarget: { slug: string; nodeId: string; baseUrl: string };
            sharedControl: { slug: string; baseUrl: string };
            dedicatedNeighbor: { slug: string; baseUrl: string };
          };
          public: { statusUrl: string; readmitUrl: string };
          openbaoPath: string;
          readinessQuery: string;
          containmentTarget: string;
          readmissionTarget: string;
        };
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    };

    const first = runProductionPlanner({
      target: "ember",
      controller: "harbor",
      dedicated: "quartz",
    });
    expect(first.controller).toMatchObject({
      slug: "harbor",
      buildSha: first.platformBuildSha,
      publicBase: "https://test.example.invalid",
      versionUrl: "https://test.example.invalid/version",
      actuator: {
        origin: "http://harbor-database-reliability-actuator:8080",
        versionUrl: "http://harbor-database-reliability-actuator:8080/version",
      },
      readmitter: {
        origin: "http://harbor-database-reliability-readmitter:8081",
      },
    });
    expect(first).toMatchObject({
      phase: "automatic-containment",
      excluded: [{ node: "quartz" }],
    });
    expect(() =>
      runProductionPlanner({
        target: "ember",
        controller: "harbor",
        dedicated: "quartz",
        phase: "combined",
      })
    ).toThrow("combined recovery proof unavailable");
    expect(() =>
      runProductionPlanner({
        target: "ember",
        controller: "harbor",
        dedicated: "quartz",
        poisonedQuery: true,
      })
    ).toThrow();
    expect(first.load).toEqual({
      budgetProfile: "shared-default-v1",
      appConnectionLimit: 2,
      clients: 1,
      databaseEnvironment: "candidate-a",
    });
    expect(() =>
      runProductionPlanner({
        target: "ember",
        controller: "harbor",
        dedicated: "quartz",
        clients: "8",
      })
    ).toThrow("shared replay clients exceed immutable app budget");
    expect(() =>
      runProductionPlanner({
        target: "red",
        controller: "harbor",
        dedicated: "quartz",
        foreignDatabase: true,
      })
    ).toThrow("shared replay refuses database residency outside candidate-a");
    expect(() =>
      runProductionPlanner({
        target: "ember",
        controller: "harbor",
        dedicated: "quartz",
        poisonedDsn: true,
      })
    ).toThrow("lane database residency disagreement");
    expect(first.validation).toMatchObject({
      sharedTarget: {
        slug: "ember",
        baseUrl: "https://ember-test.example.invalid",
      },
      sharedControl: {
        slug: "harbor",
        baseUrl: "https://test.example.invalid",
      },
      dedicatedNeighbor: {
        slug: "quartz",
        baseUrl: "https://quartz-test.example.invalid",
      },
    });
    expect(first.controller.actuator.statusPath).toContain("node_slug=ember");
    expect(first.public.statusUrl).toBe(
      `https://test.example.invalid/api/v1/nodes/${first.validation.sharedTarget.nodeId}/observability/health?env=candidate-a`
    );
    expect(first.public.readmitUrl).toBe(
      `https://test.example.invalid/api/v1/nodes/${first.validation.sharedTarget.nodeId}/observability/health`
    );
    expect(first.openbaoPath).toBe("cogni/candidate-a/ember");
    expect(first.readinessQuery).toContain('node_slug="ember"');
    expect(first.containmentTarget).toBe(first.validation.sharedTarget.nodeId);
    expect(first.readmissionTarget).toBe(first.validation.sharedTarget.nodeId);

    const renamed = runProductionPlanner({
      target: "cinder",
      controller: "lighthouse",
      dedicated: "granite",
    });
    expect(renamed.controller.slug).toBe("lighthouse");
    expect(renamed.validation.sharedTarget.slug).toBe("cinder");
    expect(renamed.validation.dedicatedNeighbor.slug).toBe("granite");
    expect(renamed.public.statusUrl).toContain(
      renamed.validation.sharedTarget.nodeId
    );
    expect(renamed.openbaoPath).toBe("cogni/candidate-a/cinder");
    expect(renamed.readinessQuery).toContain('node_slug="cinder"');
    expect(renamed).not.toEqual(first);
  });
});
