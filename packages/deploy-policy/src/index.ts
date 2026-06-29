// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/deploy-policy`
 * Purpose: Pure Kubernetes rendered-manifest resource-fit admission logic.
 * Scope: Pure resource-fit evaluation only; does not read files, render Kustomize,
 *   call Kubernetes, or mutate deploy state.
 * Invariants:
 *   - K8S_SCHEDULER_REMAINS_AUTHORITY: this predicts impossible desired state;
 *     it does not replace live scheduling.
 *   - RENDERED_MANIFESTS_ARE_INPUT: sidecars, workers, and init containers count
 *     only after they exist in the final rendered Kubernetes shape.
 *   - MISSING_REQUESTS_FAIL_CLOSED: memory and CPU requests are required.
 * Side-effects: none
 * Links: docs/design/operator-fleet-safety.md
 * @public
 */

import { parseAllDocuments, parse as parseYaml } from "yaml";

export type ResourceFitMode = "ratchet" | "strict";

export interface ResourceAmount {
  readonly memoryMi: number;
  readonly cpuMilli: number;
}

export interface EnvCapacityBudget {
  readonly env: string;
  readonly mode: ResourceFitMode;
  readonly allocatable: ResourceAmount;
  readonly reservations: {
    readonly composeMemoryMi: number;
    readonly kubeMemoryMi: number;
    readonly edgeMemoryMi: number;
    readonly requiredHeadroomMi: number;
    readonly reservedCpuMilli: number;
    readonly requiredCpuHeadroomMilli: number;
  };
  readonly rollout: {
    readonly includeMaxSurge: boolean;
  };
  readonly measurement?: {
    readonly source?: string;
    readonly measuredAt?: string;
  };
}

export interface WorkloadDemand {
  readonly kind: string;
  readonly name: string;
  readonly namespace?: string;
  readonly replicas: number;
  readonly rolloutExtraReplicas: number;
  readonly podRequestMemoryMi: number;
  readonly podRequestCpuMilli: number;
  readonly effectiveMemoryMi: number;
  readonly effectiveCpuMilli: number;
  readonly missingRequests: readonly MissingRequest[];
}

export interface MissingRequest {
  readonly workload: string;
  readonly container: string;
  readonly containerType: "container" | "initContainer";
  readonly resource: "memory" | "cpu";
}

export interface ResourceFitTotals {
  readonly requestedMemoryMi: number;
  readonly requestedCpuMilli: number;
  readonly availableMemoryMi: number;
  readonly availableCpuMilli: number;
  readonly memoryOverageMi: number;
  readonly cpuOverageMilli: number;
}

export interface ResourceFitViolation {
  readonly code:
    | "needs_measurement"
    | "missing_request"
    | "memory_over_budget"
    | "cpu_over_budget"
    | "memory_ratchet_increase"
    | "cpu_ratchet_increase";
  readonly message: string;
  readonly resource?: "memory" | "cpu";
  readonly workload?: string;
}

export interface ResourceFitReport {
  readonly env: string;
  readonly mode: ResourceFitMode;
  readonly allowed: boolean;
  readonly reason: string;
  readonly budget: {
    readonly allocatableMemoryMi: number;
    readonly allocatableCpuMilli: number;
    readonly reservedMemoryMi: number;
    readonly reservedCpuMilli: number;
    readonly requiredHeadroomMi: number;
    readonly requiredCpuHeadroomMilli: number;
    readonly measurement?: {
      readonly source?: string;
      readonly measuredAt?: string;
    };
  };
  readonly totals: ResourceFitTotals;
  readonly baselineTotals?: ResourceFitTotals;
  readonly workloads: readonly WorkloadDemand[];
  readonly violations: readonly ResourceFitViolation[];
}

type UnknownRecord = Record<string, unknown>;

export function loadEnvBudgetsFromYaml(
  yamlText: string
): Record<string, EnvCapacityBudget> {
  const raw = parseYaml(yamlText) as unknown;
  const root = asRecord(raw, "capacity root");
  const budgets: Record<string, EnvCapacityBudget> = {};

  for (const [env, value] of Object.entries(root)) {
    const item = asRecord(value, `capacity env ${env}`);
    const allocatable = asRecord(item.allocatable, `${env}.allocatable`);
    const reservations = asRecord(item.reservations, `${env}.reservations`);
    const rollout = asRecord(item.rollout ?? {}, `${env}.rollout`);
    const measurement =
      item.measurement == null
        ? undefined
        : asRecord(item.measurement, `${env}.measurement`);

    const parsedMeasurement = measurement
      ? {
          ...(typeof measurement.source === "string"
            ? { source: measurement.source }
            : {}),
          ...(typeof measurement.measuredAt === "string"
            ? { measuredAt: measurement.measuredAt }
            : {}),
        }
      : undefined;

    budgets[env] = {
      env,
      mode: parseMode(item.mode, `${env}.mode`),
      allocatable: {
        memoryMi: requiredNumber(
          allocatable.memoryMi,
          `${env}.allocatable.memoryMi`
        ),
        cpuMilli: requiredNumber(
          allocatable.cpuMilli,
          `${env}.allocatable.cpuMilli`
        ),
      },
      reservations: {
        composeMemoryMi: requiredNumber(
          reservations.composeMemoryMi,
          `${env}.reservations.composeMemoryMi`
        ),
        kubeMemoryMi: requiredNumber(
          reservations.kubeMemoryMi,
          `${env}.reservations.kubeMemoryMi`
        ),
        edgeMemoryMi: requiredNumber(
          reservations.edgeMemoryMi,
          `${env}.reservations.edgeMemoryMi`
        ),
        requiredHeadroomMi: requiredNumber(
          reservations.requiredHeadroomMi,
          `${env}.reservations.requiredHeadroomMi`
        ),
        reservedCpuMilli: requiredNumber(
          reservations.reservedCpuMilli,
          `${env}.reservations.reservedCpuMilli`
        ),
        requiredCpuHeadroomMilli: requiredNumber(
          reservations.requiredCpuHeadroomMilli,
          `${env}.reservations.requiredCpuHeadroomMilli`
        ),
      },
      rollout: {
        includeMaxSurge: rollout.includeMaxSurge !== false,
      },
      ...(parsedMeasurement ? { measurement: parsedMeasurement } : {}),
    };
  }

  return budgets;
}

export function parseKubernetesDocuments(yamlText: string): readonly unknown[] {
  return parseAllDocuments(yamlText)
    .map((doc) => doc.toJSON())
    .filter((doc) => doc != null);
}

export function extractKubernetesWorkloads(
  manifests: readonly unknown[],
  options: { readonly includeMaxSurge?: boolean } = {}
): readonly WorkloadDemand[] {
  const includeMaxSurge = options.includeMaxSurge !== false;
  const workloads: WorkloadDemand[] = [];

  for (const manifest of manifests) {
    const obj = asOptionalRecord(manifest);
    if (!obj) continue;
    const kind = stringValue(obj.kind);
    const metadata = asOptionalRecord(obj.metadata);
    const name = stringValue(metadata?.name);
    if (!kind || !name) continue;

    const workload = podTemplateFor(obj, kind);
    if (!workload) continue;

    const pod = summarizePodTemplate({
      workload: `${kind}/${name}`,
      template: workload.template,
    });
    const rolloutExtraReplicas =
      includeMaxSurge && kind === "Deployment"
        ? deploymentRolloutExtraReplicas(obj, workload.replicas)
        : 0;
    const effectiveReplicas = workload.replicas + rolloutExtraReplicas;

    workloads.push({
      kind,
      name,
      ...(typeof metadata?.namespace === "string"
        ? { namespace: metadata.namespace }
        : {}),
      replicas: workload.replicas,
      rolloutExtraReplicas,
      podRequestMemoryMi: pod.memoryMi,
      podRequestCpuMilli: pod.cpuMilli,
      effectiveMemoryMi: pod.memoryMi * effectiveReplicas,
      effectiveCpuMilli: pod.cpuMilli * effectiveReplicas,
      missingRequests: pod.missingRequests,
    });
  }

  return workloads;
}

export function evaluateResourceFit(input: {
  readonly env: string;
  readonly budget: EnvCapacityBudget;
  readonly workloads: readonly WorkloadDemand[];
  readonly baselineWorkloads?: readonly WorkloadDemand[];
  readonly mode?: ResourceFitMode;
}): ResourceFitReport {
  const mode = input.mode ?? input.budget.mode;
  const totals = totalsFor(input.budget, input.workloads);
  const baselineTotals = input.baselineWorkloads
    ? totalsFor(input.budget, input.baselineWorkloads)
    : undefined;
  const violations: ResourceFitViolation[] = [];

  if (input.budget.measurement?.source == null) {
    violations.push({
      code: "needs_measurement",
      message: `${input.env} capacity budget is missing measurement.source`,
    });
  }

  for (const workload of input.workloads) {
    for (const missing of workload.missingRequests) {
      violations.push({
        code: "missing_request",
        message: `${missing.workload} ${missing.containerType} ${missing.container} is missing ${missing.resource} request`,
        resource: missing.resource,
        workload: missing.workload,
      });
    }
  }

  addBudgetViolations({
    mode,
    totals,
    baselineTotals,
    violations,
  });

  const allowed = violations.length === 0;
  return {
    env: input.env,
    mode,
    allowed,
    reason: allowed
      ? allowedReason({ mode, totals, baselineTotals })
      : (violations[0]?.message ?? "resource-fit policy denied rendered state"),
    budget: {
      allocatableMemoryMi: input.budget.allocatable.memoryMi,
      allocatableCpuMilli: input.budget.allocatable.cpuMilli,
      reservedMemoryMi: reservedMemoryMi(input.budget),
      reservedCpuMilli: input.budget.reservations.reservedCpuMilli,
      requiredHeadroomMi: input.budget.reservations.requiredHeadroomMi,
      requiredCpuHeadroomMilli:
        input.budget.reservations.requiredCpuHeadroomMilli,
      ...(input.budget.measurement
        ? { measurement: input.budget.measurement }
        : {}),
    },
    totals,
    ...(baselineTotals ? { baselineTotals } : {}),
    workloads: input.workloads,
    violations,
  };
}

function allowedReason(input: {
  readonly mode: ResourceFitMode;
  readonly totals: ResourceFitTotals;
  readonly baselineTotals: ResourceFitTotals | undefined;
}): string {
  const { mode, totals, baselineTotals } = input;
  if (totals.memoryOverageMi === 0 && totals.cpuOverageMilli === 0) {
    return "rendered workload requests fit declared env budget";
  }
  if (mode === "ratchet" && baselineTotals) {
    const resources = [
      totals.memoryOverageMi > 0
        ? `${totals.memoryOverageMi}Mi memory overage`
        : undefined,
      totals.cpuOverageMilli > 0
        ? `${totals.cpuOverageMilli}m CPU overage`
        : undefined,
    ].filter(Boolean);
    return `ratchet pass: existing ${resources.join(" and ")} did not increase versus rendered origin/main`;
  }
  return "resource-fit policy allowed rendered state";
}

export function parseMemoryMi(quantity: unknown): number | null {
  if (typeof quantity === "number" && Number.isFinite(quantity)) {
    return quantity;
  }
  if (typeof quantity !== "string") {
    return null;
  }
  const match = /^([0-9]+(?:\.[0-9]+)?)([a-zA-Z]*)$/.exec(quantity.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2] ?? "";
  const multiplier: Record<string, number> = {
    "": 1 / (1024 * 1024),
    Ki: 1 / 1024,
    Mi: 1,
    Gi: 1024,
    Ti: 1024 * 1024,
    K: 1000 / (1024 * 1024),
    M: (1000 * 1000) / (1024 * 1024),
    G: (1000 * 1000 * 1000) / (1024 * 1024),
    T: (1000 * 1000 * 1000 * 1000) / (1024 * 1024),
  };
  const scale = multiplier[unit];
  return scale == null ? null : Math.ceil(value * scale);
}

export function parseCpuMilli(quantity: unknown): number | null {
  if (typeof quantity === "number" && Number.isFinite(quantity)) {
    return Math.round(quantity * 1000);
  }
  if (typeof quantity !== "string") {
    return null;
  }
  const trimmed = quantity.trim();
  if (trimmed.endsWith("m")) {
    const value = Number(trimmed.slice(0, -1));
    return Number.isFinite(value) ? Math.ceil(value) : null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? Math.ceil(value * 1000) : null;
}

function addBudgetViolations(input: {
  readonly mode: ResourceFitMode;
  readonly totals: ResourceFitTotals;
  readonly baselineTotals: ResourceFitTotals | undefined;
  readonly violations: ResourceFitViolation[];
}): void {
  const { mode, totals, baselineTotals, violations } = input;
  if (mode === "strict" || !baselineTotals) {
    if (totals.memoryOverageMi > 0) {
      violations.push({
        code: "memory_over_budget",
        message: `memory over budget by ${totals.memoryOverageMi}Mi including rollout surge`,
        resource: "memory",
      });
    }
    if (totals.cpuOverageMilli > 0) {
      violations.push({
        code: "cpu_over_budget",
        message: `cpu over budget by ${totals.cpuOverageMilli}m including rollout surge`,
        resource: "cpu",
      });
    }
    return;
  }

  if (totals.memoryOverageMi > baselineTotals.memoryOverageMi) {
    violations.push({
      code: "memory_ratchet_increase",
      message: `memory overage increased by ${totals.memoryOverageMi - baselineTotals.memoryOverageMi}Mi versus rendered origin/main`,
      resource: "memory",
    });
  }
  if (totals.cpuOverageMilli > baselineTotals.cpuOverageMilli) {
    violations.push({
      code: "cpu_ratchet_increase",
      message: `cpu overage increased by ${totals.cpuOverageMilli - baselineTotals.cpuOverageMilli}m versus rendered origin/main`,
      resource: "cpu",
    });
  }
}

function totalsFor(
  budget: EnvCapacityBudget,
  workloads: readonly WorkloadDemand[]
): ResourceFitTotals {
  const requestedMemoryMi = sum(workloads.map((w) => w.effectiveMemoryMi));
  const requestedCpuMilli = sum(workloads.map((w) => w.effectiveCpuMilli));
  const availableMemoryMi =
    budget.allocatable.memoryMi -
    reservedMemoryMi(budget) -
    budget.reservations.requiredHeadroomMi;
  const availableCpuMilli =
    budget.allocatable.cpuMilli -
    budget.reservations.reservedCpuMilli -
    budget.reservations.requiredCpuHeadroomMilli;
  return {
    requestedMemoryMi,
    requestedCpuMilli,
    availableMemoryMi,
    availableCpuMilli,
    memoryOverageMi: Math.max(0, requestedMemoryMi - availableMemoryMi),
    cpuOverageMilli: Math.max(0, requestedCpuMilli - availableCpuMilli),
  };
}

function summarizePodTemplate(input: {
  readonly workload: string;
  readonly template: UnknownRecord;
}): ResourceAmount & { readonly missingRequests: readonly MissingRequest[] } {
  const spec = asOptionalRecord(input.template.spec) ?? {};
  const containers = arrayOfRecords(spec.containers);
  const initContainers = arrayOfRecords(spec.initContainers);
  const missingRequests: MissingRequest[] = [];

  if (containers.length === 0) {
    missingRequests.push({
      workload: input.workload,
      container: "<none>",
      containerType: "container",
      resource: "memory",
    });
    missingRequests.push({
      workload: input.workload,
      container: "<none>",
      containerType: "container",
      resource: "cpu",
    });
  }

  const app = containers.reduce<ResourceAmount>(
    (acc, container) => {
      const request = containerRequest({
        workload: input.workload,
        container,
        containerType: "container",
        missingRequests,
      });
      return {
        memoryMi: acc.memoryMi + request.memoryMi,
        cpuMilli: acc.cpuMilli + request.cpuMilli,
      };
    },
    { memoryMi: 0, cpuMilli: 0 }
  );

  const init = initContainers.reduce<ResourceAmount>(
    (acc, container) => {
      const request = containerRequest({
        workload: input.workload,
        container,
        containerType: "initContainer",
        missingRequests,
      });
      return {
        memoryMi: Math.max(acc.memoryMi, request.memoryMi),
        cpuMilli: Math.max(acc.cpuMilli, request.cpuMilli),
      };
    },
    { memoryMi: 0, cpuMilli: 0 }
  );

  return {
    memoryMi: Math.max(app.memoryMi, init.memoryMi),
    cpuMilli: Math.max(app.cpuMilli, init.cpuMilli),
    missingRequests,
  };
}

function containerRequest(input: {
  readonly workload: string;
  readonly container: UnknownRecord;
  readonly containerType: "container" | "initContainer";
  readonly missingRequests: MissingRequest[];
}): ResourceAmount {
  const name = stringValue(input.container.name) ?? "<unnamed>";
  const resources = asOptionalRecord(input.container.resources);
  const requests = asOptionalRecord(resources?.requests);
  const memory = parseMemoryMi(requests?.memory);
  const cpu = parseCpuMilli(requests?.cpu);

  if (memory == null) {
    input.missingRequests.push({
      workload: input.workload,
      container: name,
      containerType: input.containerType,
      resource: "memory",
    });
  }
  if (cpu == null) {
    input.missingRequests.push({
      workload: input.workload,
      container: name,
      containerType: input.containerType,
      resource: "cpu",
    });
  }

  return {
    memoryMi: memory ?? 0,
    cpuMilli: cpu ?? 0,
  };
}

function podTemplateFor(
  resource: UnknownRecord,
  kind: string
): { readonly template: UnknownRecord; readonly replicas: number } | null {
  const spec = asOptionalRecord(resource.spec);
  if (!spec) return null;

  if (kind === "Pod") {
    return { template: resource, replicas: 1 };
  }
  if (
    kind === "Deployment" ||
    kind === "StatefulSet" ||
    kind === "ReplicaSet"
  ) {
    const template = asOptionalRecord(spec.template);
    if (!template) return null;
    return {
      template,
      replicas: numberValue(spec.replicas) ?? 1,
    };
  }
  if (kind === "Job") {
    const template = asOptionalRecord(spec.template);
    if (!template) return null;
    return { template, replicas: numberValue(spec.parallelism) ?? 1 };
  }
  if (kind === "CronJob") {
    const jobTemplate = asOptionalRecord(spec.jobTemplate);
    const jobSpec = asOptionalRecord(jobTemplate?.spec);
    const template = asOptionalRecord(jobSpec?.template);
    if (!template) return null;
    return { template, replicas: numberValue(jobSpec?.parallelism) ?? 1 };
  }
  if (kind === "DaemonSet") {
    const template = asOptionalRecord(spec.template);
    if (!template) return null;
    return { template, replicas: 1 };
  }
  return null;
}

function deploymentRolloutExtraReplicas(
  resource: UnknownRecord,
  replicas: number
): number {
  const spec = asOptionalRecord(resource.spec);
  const strategy = asOptionalRecord(spec?.strategy);
  if (strategy?.type === "Recreate" || replicas <= 0) {
    return 0;
  }
  const rollingUpdate = asOptionalRecord(strategy?.rollingUpdate);
  return parseMaxSurge(rollingUpdate?.maxSurge, replicas);
}

function parseMaxSurge(raw: unknown, replicas: number): number {
  if (raw == null) return Math.ceil(replicas * 0.25);
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.ceil(raw));
  }
  if (typeof raw !== "string") return Math.ceil(replicas * 0.25);
  const trimmed = raw.trim();
  if (trimmed.endsWith("%")) {
    const pct = Number(trimmed.slice(0, -1));
    return Number.isFinite(pct)
      ? Math.max(0, Math.ceil((replicas * pct) / 100))
      : Math.ceil(replicas * 0.25);
  }
  const value = Number(trimmed);
  return Number.isFinite(value)
    ? Math.max(0, Math.ceil(value))
    : Math.ceil(replicas * 0.25);
}

function reservedMemoryMi(budget: EnvCapacityBudget): number {
  return (
    budget.reservations.composeMemoryMi +
    budget.reservations.kubeMemoryMi +
    budget.reservations.edgeMemoryMi
  );
}

function parseMode(raw: unknown, path: string): ResourceFitMode {
  if (raw === "ratchet" || raw === "strict") {
    return raw;
  }
  throw new Error(`${path} must be "ratchet" or "strict"`);
}

function requiredNumber(raw: unknown, path: string): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  throw new Error(`${path} must be a number`);
}

function asRecord(raw: unknown, path: string): UnknownRecord {
  const record = asOptionalRecord(raw);
  if (!record) {
    throw new Error(`${path} must be an object`);
  }
  return record;
}

function asOptionalRecord(raw: unknown): UnknownRecord | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as UnknownRecord)
    : null;
}

function arrayOfRecords(raw: unknown): readonly UnknownRecord[] {
  return Array.isArray(raw)
    ? raw.reduce<UnknownRecord[]>((items, item) => {
        const record = asOptionalRecord(item);
        if (record) items.push(record);
        return items;
      }, [])
    : [];
}

function stringValue(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function numberValue(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function sum(values: readonly number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}
