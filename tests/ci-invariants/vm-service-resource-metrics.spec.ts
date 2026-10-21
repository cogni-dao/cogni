// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/vm-service-resource-metrics`
 * Purpose: Pin per-service VM memory/swap/cpu/io attribution and keep every fleet query on retained metric families.
 * Scope: Static reads of the committed Alloy metrics config, fleet dashboards and alert YAML. Does not access the network, docker or Grafana.
 * Invariants:
 *   - SWAP_AND_RSS_RETAINED: the infra allowlist keeps container_memory_rss and container_memory_swap.
 *   - EVERY_VM_SERVICE_CLASSIFIED: compose, systemd and kubepods cgroups get a `class`; unclassified
 *     container series are dropped, and the compose mapping cannot erase a systemd `service`.
 *   - K3S_PODS_NAMED: a kubelet `/metrics/cadvisor` scrape feeds a dedicated relabel that names pods
 *     `<namespace>/<owner>` and drops pod/uid churn labels.
 *   - QUERIES_USE_RETAINED_FAMILIES: every container_/node_/pg_ family referenced by a fleet dashboard
 *     or alert survives the Alloy allowlists; a dropped family would render a silently empty panel.
 * Side-effects: IO (reads committed files)
 * Links: story.5084, docs/spec/observability.md, infra/compose/runtime/configs/alloy-config.metrics.alloy
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const read = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

const alloy = read("infra/compose/runtime/configs/alloy-config.metrics.alloy");
const STATUS_DASHBOARD = "infra/grafana/dashboards/operator/fleet-status.json";
const CAPACITY_DASHBOARD =
  "infra/grafana/dashboards/operator/fleet-capacity.json";
const ALERTS = "infra/grafana/alerts/fleet-capacity.alerts.yaml";

/** Body of one top-level Alloy block, e.g. `prometheus.relabel "infra_metrics"`. */
function block(header: string): string {
  const start = alloy.indexOf(`${header} {`);
  expect(start, `${header} must exist`).toBeGreaterThanOrEqual(0);
  const end = alloy.indexOf("\n}\n", start);
  return alloy.slice(start, end);
}

/** Metric names of the first `action = "keep"` __name__ rule in a relabel block. */
function keptFamilies(body: string): Set<string> {
  const match = body.match(
    /source_labels = \["__name__"\]\s*\n\s*regex\s*=\s*"\(([^"]+)\)"\s*\n\s*action\s*=\s*"keep"/
  );
  expect(
    match,
    "relabel block must start with a __name__ keep rule"
  ).toBeTruthy();
  return new Set((match?.[1] ?? "").split("|"));
}

const infra = block('prometheus.relabel "infra_metrics"');
const k8s = block('prometheus.relabel "k8s_container_metrics"');
const infraFamilies = keptFamilies(infra);
const k8sFamilies = keptFamilies(k8s);

// A family token is a metric selector, not a label matcher (`node_slug="x"`), a grouping
// clause label (`by (node_slug)`) or a dotted feature name.
const FAMILY =
  /(?<![\w.])((?:container|node|pg)_[A-Za-z0-9_]+)(?![\w.]|\s*[=!]~?)/g;
const GROUPING =
  /\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g;

function exprsOfDashboard(relative: string): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key === "expr" && typeof child === "string") out.push(child);
        else walk(child);
      }
    }
  };
  walk(JSON.parse(read(relative)));
  return out;
}

interface AlertRule {
  readonly uid: string;
  readonly data: ReadonlyArray<{ readonly model: { readonly expr?: string } }>;
}
const alertRules = (
  yaml.parse(read(ALERTS)) as {
    groups: ReadonlyArray<{ rules: readonly AlertRule[] }>;
  }
).groups.flatMap((group) => group.rules);

describe("VM service resource attribution (story.5084)", () => {
  it("retains RSS and swap for every attributed service", () => {
    for (const family of ["container_memory_rss", "container_memory_swap"]) {
      expect(infraFamilies.has(family)).toBe(true);
      expect(k8sFamilies.has(family)).toBe(true);
    }
  });

  it("classifies compose, systemd and kubepods cgroups before dropping the anonymous rest", () => {
    const classify = infra.indexOf('replacement   = "compose"');
    const systemd = infra.indexOf('replacement   = "systemd"');
    const total = infra.indexOf('replacement   = "k8s-total"');
    const drop = infra.indexOf(
      'source_labels = ["__name__", "class"]\n    regex         = "container_.*;"\n    action        = "drop"'
    );
    for (const index of [classify, systemd, total, drop]) {
      expect(index).toBeGreaterThan(0);
    }
    expect(Math.max(classify, systemd, total)).toBeLessThan(drop);
    // Only direct system.slice units (leaf level), never nested sub-cgroups.
    expect(infra).toContain(
      'regex         = "container_[^;]*;/system\\\\.slice/([^/]+)\\\\.service"'
    );
    // The compose service mapping must not erase a systemd/kubepods `service`.
    expect(infra).toMatch(
      /source_labels = \["container_label_com_docker_compose_service"\]\s*\n\s*regex\s*=\s*"\(\.\+\)"\s*\n\s*target_label\s*=\s*"service"/
    );
    // The old compose-only drop that hid ~75% of host memory is gone.
    expect(infra).not.toContain(
      'source_labels = ["__name__", "container_label_com_docker_compose_service"]\n    regex         = "container_.*;"\n    action        = "drop"'
    );
  });

  it("scrapes named k3s pods from the kubelet cAdvisor endpoint", () => {
    const scrape = block('prometheus.scrape "kubelet_cadvisor"');
    expect(scrape).toContain('"host.docker.internal:10250"');
    expect(scrape).toContain('metrics_path    = "/metrics/cadvisor"');
    expect(scrape).toContain('scheme          = "https"');
    expect(scrape).toContain(
      "forward_to      = [prometheus.relabel.k8s_container_metrics.receiver]"
    );
    expect(scrape).toContain(
      "/host/root/var/lib/rancher/k3s/server/tls/client-kube-apiserver.key"
    );
    expect(k8s).toContain('replacement  = "k8s"');
    expect(k8s).toContain('regex  = "(id|image|name|pod|uid)"');
    expect(k8s).toContain(
      "forward_to = [prometheus.remote_write.grafana_cloud.receiver]"
    );
    for (const family of [
      "container_memory_working_set_bytes",
      "container_memory_rss",
      "container_memory_swap",
      "container_cpu_usage_seconds_total",
      "container_fs_reads_bytes_total",
      "container_fs_writes_bytes_total",
      "container_memory_failures_total",
      "container_oom_events_total",
      "container_spec_memory_limit_bytes",
    ]) {
      expect(k8sFamilies.has(family)).toBe(true);
    }
  });

  it("names pods by owner and keeps StatefulSet ordinals", () => {
    const ownerRegex = k8s.match(
      /regex\s*=\s*"(\(\[\^\/\]\+\)\/\(\.\+\?\)[^"]+)"/
    )?.[1];
    expect(ownerRegex).toBeDefined();
    const owner = new RegExp(`^${ownerRegex}$`);
    const service = (namespace: string, pod: string): string => {
      const joined = `${namespace}/${pod}`;
      const match = joined.match(owner);
      return match ? `${match[1]}/${match[2]}` : joined;
    };
    expect(
      service("cogni-production", "operator-node-app-7d9f8b6c5d-x2k4m")
    ).toBe("cogni-production/operator-node-app");
    expect(service("argocd", "argocd-repo-server-5f6b7c8d9-abcde")).toBe(
      "argocd/argocd-repo-server"
    );
    expect(service("kube-system", "svclb-edge-q8w2z")).toBe(
      "kube-system/svclb-edge"
    );
    expect(service("openbao", "openbao-0")).toBe("openbao/openbao-0");
  });

  it("queries only retained metric families in fleet dashboards and alerts", () => {
    const retained = new Set([...infraFamilies, ...k8sFamilies]);
    const exprs = [
      ...exprsOfDashboard(STATUS_DASHBOARD),
      ...exprsOfDashboard(CAPACITY_DASHBOARD),
      ...alertRules.flatMap((rule) =>
        rule.data.map((datum) => datum.model.expr ?? "")
      ),
    ];
    const missing = new Set<string>();
    for (const expr of exprs) {
      for (const [, family] of expr.replace(GROUPING, "").matchAll(FAMILY)) {
        if (family && !retained.has(family)) missing.add(family);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it("ships the VM resources row and capacity alerts", () => {
    const dashboard = JSON.parse(read(STATUS_DASHBOARD)) as {
      panels: ReadonlyArray<{ id: number; title: string; type: string }>;
    };
    const ids = dashboard.panels.map((panel) => panel.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      dashboard.panels.some(
        (panel) => panel.type === "row" && panel.title === "VM resources"
      )
    ).toBe(true);
    for (const environment of ["Production", "Preview", "Candidate-a"]) {
      expect(
        dashboard.panels.some((panel) =>
          panel.title.startsWith(`${environment} · top 15 services`)
        )
      ).toBe(true);
    }
    const uids = alertRules.map((rule) => rule.uid);
    expect(uids.slice(-3)).toEqual([
      "fleet-vm-memory-25",
      "fleet-db-major-faults",
      "fleet-vm-disk-80",
    ]);
    // `${uid}-production` must fit Grafana's 40-character UID bound.
    for (const uid of uids)
      expect(`${uid}-production`.length).toBeLessThanOrEqual(40);
  });
});
