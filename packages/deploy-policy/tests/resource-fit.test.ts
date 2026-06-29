// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/deploy-policy/tests/resource-fit`
 * Purpose: Unit tests for rendered Kubernetes resource-fit demand extraction and budget evaluation.
 * Scope: Tests pure package APIs only; does not render Kustomize, run Conftest, or touch live clusters.
 * Invariants:
 *   - Sidecars, init containers, CPU/memory requests, and rollout surge are counted.
 *   - Missing requests fail closed.
 * Side-effects: none
 * Links: docs/design/operator-fleet-safety.md
 * @internal
 */

import {
  evaluateResourceFit,
  extractKubernetesWorkloads,
  loadEnvBudgetsFromYaml,
  parseKubernetesDocuments,
  parseMemoryMi,
} from "../src";

const budget = loadEnvBudgetsFromYaml(`
production:
  mode: strict
  allocatable:
    memoryMi: 2000
    cpuMilli: 2000
  reservations:
    composeMemoryMi: 100
    kubeMemoryMi: 100
    edgeMemoryMi: 50
    requiredHeadroomMi: 100
    reservedCpuMilli: 100
    requiredCpuHeadroomMilli: 100
  rollout:
    includeMaxSurge: true
  measurement:
    source: test
    measuredAt: "2026-06-29"
`).production;

function workloads(yaml: string) {
  return extractKubernetesWorkloads(parseKubernetesDocuments(yaml), {
    includeMaxSurge: true,
  });
}

describe("resource-fit policy", () => {
  it("counts sidecar containers and deployment rollout surge", () => {
    const [workload] = workloads(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: poly
spec:
  replicas: 2
  strategy:
    rollingUpdate:
      maxSurge: 1
  template:
    spec:
      containers:
        - name: app
          resources:
            requests:
              memory: 256Mi
              cpu: 100m
        - name: sidecar
          resources:
            requests:
              memory: 128Mi
              cpu: 50m
`);

    expect(workload).toMatchObject({
      name: "poly",
      replicas: 2,
      rolloutExtraReplicas: 1,
      podRequestMemoryMi: 384,
      podRequestCpuMilli: 150,
      effectiveMemoryMi: 1152,
      effectiveCpuMilli: 450,
    });
  });

  it("uses max init-container request instead of summing init containers", () => {
    const [workload] = workloads(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: operator
spec:
  strategy:
    type: Recreate
  template:
    spec:
      initContainers:
        - name: migrate-a
          resources:
            requests:
              memory: 384Mi
              cpu: 200m
        - name: migrate-b
          resources:
            requests:
              memory: 512Mi
              cpu: 100m
      containers:
        - name: app
          resources:
            requests:
              memory: 256Mi
              cpu: 100m
`);

    expect(workload?.podRequestMemoryMi).toBe(512);
    expect(workload?.podRequestCpuMilli).toBe(200);
  });

  it("fails closed when memory or cpu requests are missing", () => {
    const report = evaluateResourceFit({
      env: "production",
      budget,
      workloads: workloads(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bad
spec:
  template:
    spec:
      containers:
        - name: app
          resources:
            requests:
              memory: 128Mi
`),
    });

    expect(report.allowed).toBe(false);
    expect(report.violations.map((v) => v.code)).toContain("missing_request");
    expect(report.reason).toMatch(/missing cpu request/);
  });

  it("fails strict mode when rendered requests exceed available budget", () => {
    const report = evaluateResourceFit({
      env: "production",
      budget,
      workloads: workloads(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: huge
spec:
  template:
    spec:
      containers:
        - name: app
          resources:
            requests:
              memory: 2Gi
              cpu: "2"
`),
    });

    expect(report.allowed).toBe(false);
    expect(report.violations.map((v) => v.code)).toContain(
      "memory_over_budget"
    );
    expect(report.violations.map((v) => v.code)).toContain("cpu_over_budget");
  });

  it("ratchets against the rendered origin/main baseline", () => {
    const ratchetBudget = { ...budget, mode: "ratchet" as const };
    const baseline = workloads(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: baseline
spec:
  template:
    spec:
      containers:
        - name: app
          resources:
            requests:
              memory: 2Gi
              cpu: "2"
`);
    const reduced = workloads(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: baseline
spec:
  template:
    spec:
      containers:
        - name: app
          resources:
            requests:
              memory: 1600Mi
              cpu: 1500m
`);

    const report = evaluateResourceFit({
      env: "production",
      budget: ratchetBudget,
      workloads: reduced,
      baselineWorkloads: baseline,
    });

    expect(report.allowed).toBe(true);
    expect(report.baselineTotals?.memoryOverageMi).toBeGreaterThan(
      report.totals.memoryOverageMi
    );
  });

  it("parses Kubernetes memory units into Mi", () => {
    expect(parseMemoryMi("1Gi")).toBe(1024);
    expect(parseMemoryMi("512Mi")).toBe(512);
  });
});
