// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Current native observation only. GET/list/log and owned ledger reads; no ensure/exec/Secret.
 * All original promises settle before sample returns, including after deadline or disconnect.
 */
import { parse as parseYaml } from "yaml";
import { ComputeProofRequestSchema } from "@/contracts/compute.release-proof.v1.contract";
import { cogniNodeAppMigrationPhases } from "@/features/compute/akash-tx/akash-tx-migration-step";
import { assessComputeWorkloadReadiness } from "@/features/compute/compute-workload-readiness";
import {
  commandTemplate,
  projectService,
  record,
} from "@/features/compute/release-proof/projection";
import {
  canonicalProofJson,
  computeProofHash,
} from "@/features/compute/release-proof/request";
import type {
  AkashTxConsolePort,
  ComputeProofAllocationReadPort,
  ComputeReleaseProofPort,
  ProofKubeReadClient,
} from "@/ports";
import {
  diffDeclaredVsApplied,
  parseMigrationReceipt,
} from "@/shared/migrations/migration-receipt";
import { withDatabaseCaTrust } from "@/shared/secrets/database-ca-command";
import type {
  ComputeReleaseProofInput,
  ComputeReleaseProofOutput,
  ProofVerdict,
} from "@/types/compute-release-proof";

type Workload = ComputeReleaseProofInput["expected"]["workloads"][number];
const same = (a: unknown, b: unknown) =>
  canonicalProofJson(a) === canonicalProofJson(b);
function declaredSubset(expected: unknown, live: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(live) &&
      expected.length === live.length &&
      expected.every((v, i) => declaredSubset(v, live[i]))
    );
  if (expected && typeof expected === "object") {
    if (!live || typeof live !== "object" || Array.isArray(live)) return false;
    return Object.entries(expected).every(([k, v]) =>
      declaredSubset(v, (live as Record<string, unknown>)[k])
    );
  }
  return expected === live;
}
const array = (v: unknown): unknown[] => {
  if (!Array.isArray(v) || v.length > 64) throw new Error("unavailable");
  return v;
};
function list(v: unknown): unknown[] {
  const r = record(v);
  if (record(r.metadata ?? {}).continue) throw new Error("unavailable");
  const items = array(r.items);
  if (items.length >= 9) throw new Error("unavailable");
  return items;
}
const segment = (s: string) => encodeURIComponent(s);
export class NativeComputeReleaseProofAdapter
  implements ComputeReleaseProofPort
{
  constructor(
    private readonly kube: ProofKubeReadClient,
    private readonly allocations: ComputeProofAllocationReadPort | undefined,
    private readonly provider: Pick<
      AkashTxConsolePort,
      "readManagedDefinition"
    >,
    private readonly localOperator?: {
      nodeId: string;
      repository: string;
      namespace: string;
    }
  ) {}
  async sample(
    raw: ComputeReleaseProofInput,
    parent: AbortSignal
  ): Promise<ComputeReleaseProofOutput> {
    const input = ComputeProofRequestSchema.parse(raw);
    parent.throwIfAborted();
    const signal = AbortSignal.any([parent, AbortSignal.timeout(20_000)]);
    const dimensions: ComputeReleaseProofOutput["dimensions"][number][] = [];
    // Sequential native operations are deliberately below the <=2 fanout bound.
    for (const w of input.expected.workloads) {
      const name =
        input.expected.nodeId + (w.instance === null ? "" : `-${w.instance}`);
      let native: ProofVerdict = "unavailable",
        migration: ProofVerdict = "unavailable",
        provider: ProofVerdict = "unavailable";
      let code: ComputeReleaseProofOutput["dimensions"][number]["code"] =
        "unavailable";
      try {
        signal.throwIfAborted();
        const ns = `cogni-${input.expected.environment}`;
        if (w.kind === "Deployment") {
          const result = await this.k3s(input, w, ns, signal);
          dimensions.push({ workload: name, ...result });
          continue;
        }
        const plural =
          w.kind === "XComputeWorkload"
            ? "xcomputeworkloads"
            : "computeworkloads";
        const live = record(
          await this.kube.json(
            `/apis/compute.cogni.io/v1alpha1/namespaces/${ns}/${plural}/${name}`,
            signal
          )
        );
        const metadata = record(live.metadata),
          spec = record(live.spec),
          bundle = record(spec.bundle),
          source = record(bundle.source),
          workload = record(spec.workload);
        const slug = workload.name;
        if (
          typeof slug !== "string" ||
          !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) ||
          metadata.name !== name ||
          metadata.namespace !== ns ||
          spec.nodeId !== input.expected.nodeId ||
          spec.environment !== input.expected.environment ||
          source.repository !== input.expected.repository ||
          record(metadata.labels)["cogni.io/node-id"] !==
            input.expected.nodeId ||
          record(metadata.labels)["cogni.io/environment"] !==
            input.expected.environment ||
          record(metadata.labels)["cogni.io/node"] !== slug ||
          (spec.instance ?? null) !== w.instance
        )
          throw new Error("ownership");
        if (source.sha !== input.expected.sourceSha)
          throw new Error("wrong_source");
        if (
          bundle.ref !== input.expected.bundleRef ||
          !same(bundle.artifacts, w.artifacts)
        )
          throw new Error("stale_bundle");
        const projected = array(workload.services).map(projectService);
        if (
          !same(projected, w.services) ||
          workload.publicHost !== (w.publicHost ?? "") ||
          (spec.leaseGeneration ?? 0) !== w.leaseGeneration
        )
          throw new Error("stale_bundle");
        const ready = assessComputeWorkloadReadiness({
          expected: {
            apiVersion: "compute.cogni.io/v1alpha1",
            kind: w.kind,
            metadata: { name, namespace: ns },
            spec: {
              nodeId: input.expected.nodeId,
              environment: input.expected.environment,
              bundle: {
                ref: input.expected.bundleRef,
                source: {
                  repository: input.expected.repository,
                  sha: input.expected.sourceSha,
                },
                artifacts: w.artifacts,
              },
              workload: {
                name: slug,
                publicHost: w.publicHost ?? "",
                services: array(workload.services),
              },
              ...(w.kind === "XComputeWorkload"
                ? {
                    leaseGeneration: w.leaseGeneration,
                    migration: { policy: "RequireBeforeServing" },
                    ...(w.instance === null ? {} : { instance: w.instance }),
                  }
                : {}),
            },
          },
          live,
        });
        if (!ready.ready) throw new Error("actuator_lag");
        native = "verified";
        // Handle comes only from the owned allocation. The public input cannot select one.
        if (!this.allocations) throw new Error("unavailable");
        const rows = await this.allocations.readOwnedAllocations(
          {
            nodeId: input.expected.nodeId,
            environment: input.expected.environment,
          },
          signal
        );
        signal.throwIfAborted();
        if (rows.length >= 33) throw new Error("ownership");
        const matches = rows.filter(
          (r) =>
            r.workload === slug &&
            r.identity.nodeId === input.expected.nodeId &&
            r.identity.compositeUid === metadata.uid &&
            r.identity.compositeGeneration === metadata.generation &&
            r.state === "allocated" &&
            r.externalName
        );
        if (matches.length !== 1) throw new Error("ownership");
        const allocation = required(matches[0]);
        if (!this.provider.readManagedDefinition || !allocation.externalName)
          throw new Error("provider_unavailable");
        const observed = await this.provider.readManagedDefinition({
          leaseId: allocation.externalName,
          signal,
        });
        signal.throwIfAborted();
        if (
          observed.leaseId !== allocation.externalName ||
          observed.providerAccount !== allocation.providerAccount ||
          observed.consoleManifestVersion !== observed.chainManifestVersion
        )
          throw new Error("provider_unavailable");
        this.checkProvider(w, observed);
        provider = "verified";
        migration = await this.migration(input, w, slug, ns, signal);
        code =
          migration === "verified"
            ? "verified"
            : migration === "failed"
              ? "migration_failed"
              : migration === "running"
                ? "migration_running"
                : "migration_unavailable";
      } catch (error) {
        const finite = [
          "absent",
          "ownership",
          "wrong_source",
          "stale_bundle",
          "actuator_lag",
          "unsupported_command",
          "provider_unavailable",
        ] as const;
        const message = error instanceof Error ? error.message : "";
        code = finite.find((x) => x === message) ?? "unavailable";
        if (code === "actuator_lag") native = "running";
      }
      if (signal.aborted) {
        native = "unavailable";
        migration = "unavailable";
        provider = "unavailable";
        code = "unavailable";
      }
      dimensions.push({ workload: name, native, migration, provider, code });
    }
    // A late original call is never allowed to produce a positive sample.
    if (signal.aborted)
      for (let i = 0; i < dimensions.length; i++)
        dimensions[i] = {
          ...required(dimensions[i]),
          native: "unavailable",
          migration: "unavailable",
          provider: "unavailable",
          code: "unavailable",
        };
    const { workloads: _, ...tuple } = input.expected;
    return {
      version: 1,
      hash: computeProofHash(input),
      nonce: input.nonce,
      tuple,
      observedAt: new Date().toISOString(),
      dimensions,
    };
  }
  /** Existing k3s gates remain. This read never infers an unrecorded bundle/source identity. */
  private async k3s(
    input: ComputeReleaseProofInput,
    w: Workload,
    ns: string,
    signal: AbortSignal
  ): Promise<
    Omit<ComputeReleaseProofOutput["dimensions"][number], "workload">
  > {
    const unavailable = {
      native: "unavailable" as const,
      migration: "unavailable" as ProofVerdict,
      provider: "unavailable" as const,
      code: "unavailable" as const,
    };
    if (
      !this.localOperator ||
      input.expected.nodeId !== this.localOperator.nodeId ||
      input.expected.repository !== this.localOperator.repository ||
      ns !== this.localOperator.namespace ||
      w.instance !== null ||
      w.services.length !== 1 ||
      w.services[0]?.name !== "app" ||
      w.artifacts.length !== 1
    )
      return unavailable;
    const deployment = record(
      await this.kube.json(
        `/apis/apps/v1/namespaces/${ns}/deployments/operator-node-app`,
        signal
      )
    );
    const meta = record(deployment.metadata),
      spec = record(deployment.spec),
      status = record(deployment.status ?? {}),
      template = record(record(spec.template).spec);
    if (
      meta.name !== "operator-node-app" ||
      meta.namespace !== ns ||
      typeof meta.uid !== "string" ||
      meta.deletionTimestamp ||
      !Number.isSafeInteger(meta.generation) ||
      status.observedGeneration !== meta.generation ||
      spec.replicas !== 1 ||
      status.replicas !== 1 ||
      status.updatedReplicas !== 1 ||
      status.readyReplicas !== 1 ||
      status.availableReplicas !== 1
    )
      return unavailable;
    const service = required(w.services[0]),
      image = w.artifacts.find((a) => a.name === service.artifact)?.image;
    const app = array(template.containers);
    if (
      app.length !== 1 ||
      record(app[0]).name !== "app" ||
      record(app[0]).image !== image ||
      commandTemplate(record(app[0])) !== service.commandTemplate
    )
      return unavailable;
    const pods = list(
      await this.kube.json(
        `/api/v1/namespaces/${ns}/pods?labelSelector=app.kubernetes.io%2Fname%3Dnode-app&limit=9`,
        signal
      )
    ).map(record);
    const candidate = pods.filter((p) => {
      const m = record(p.metadata),
        s = record(p.status ?? {});
      return (
        !m.deletionTimestamp &&
        s.phase === "Running" &&
        array(s.conditions ?? []).some(
          (c) => record(c).type === "Ready" && record(c).status === "True"
        ) &&
        array(record(p.spec).containers).some(
          (c) => record(c).name === "app" && record(c).image === image
        )
      );
    });
    if (candidate.length !== 1) return unavailable;
    const pod = required(candidate[0]),
      pm = record(pod.metadata),
      owners = array(pm.ownerReferences ?? [])
        .map(record)
        .filter((o) => o.kind === "ReplicaSet" && o.controller === true);
    const owner = owners[0];
    if (
      owners.length !== 1 ||
      !owner ||
      typeof owner.name !== "string" ||
      !/^operator-node-app-[a-z0-9]+$/.test(owner.name) ||
      typeof pm.name !== "string" ||
      !/^operator-node-app-[a-z0-9]+-[a-z0-9]+$/.test(pm.name)
    )
      return unavailable;
    const replicaSet = record(
      await this.kube.json(
        `/apis/apps/v1/namespaces/${ns}/replicasets/${segment(owner.name)}`,
        signal
      )
    );
    if (
      record(replicaSet.metadata).uid !== owner.uid ||
      !array(record(replicaSet.metadata).ownerReferences ?? []).some(
        (o) =>
          record(o).uid === meta.uid &&
          record(o).kind === "Deployment" &&
          record(o).controller === true
      ) ||
      !declaredSubset(spec.template, record(replicaSet.spec).template) ||
      !declaredSubset(template, record(pod.spec))
    )
      return unavailable;
    const phases = [
      {
        name: "migrate",
        key: "DATABASE_MIGRATION_URL",
        secret: "operator-migration-secrets",
        command: [
          "/bin/sh",
          "-c",
          "exec node /app/nodes/$(NODE_NAME)/app/migrate.mjs /app/nodes/$(NODE_NAME)/app/migrations",
        ],
      },
      {
        name: "migrate-doltgres",
        key: "DOLTGRES_URL",
        secret: "operator-env-secrets",
        command: [
          "/bin/sh",
          "-c",
          'exec node --input-type=module -e \'import { migrateOperatorAfterNativeDrain } from "/app/nodes/operator/app/migrate-doltgres.mjs"; await migrateOperatorAfterNativeDrain("/app/nodes/operator/app/doltgres-migrations")\'',
        ],
      },
    ];
    const init = array(template.initContainers).map(record),
      states = array(record(pod.status).initContainerStatuses ?? []).map(
        record
      );
    if (init.length !== phases.length) return unavailable;
    for (const phase of phases) {
      const container = init.find((c) => c.name === phase.name),
        state = states.find((c) => c.name === phase.name);
      if (
        !container ||
        !state ||
        container.image !== image ||
        state.image !== image ||
        !same(container.command, phase.command) ||
        record(record(state.state).terminated).exitCode !== 0
      )
        return unavailable;
      const env = array(container.env).map(record),
        db = env.find((e) => e.name === "DATABASE_URL");
      if (
        !db ||
        !same(record(db.valueFrom).secretKeyRef, {
          name: phase.secret,
          key: phase.key,
        })
      )
        return unavailable;
      const log = await this.kube.log(
        `/api/v1/namespaces/${ns}/pods/${segment(pm.name)}/log?container=${phase.name}&limitBytes=65536`,
        signal
      );
      if (phase.name === "migrate") {
        const receipt = parseMigrationReceipt(
          log.slice(log.lastIndexOf("COGNI_MIGRATION_RECEIPT_V1"))
        );
        if (
          !receipt ||
          receipt.node !== "operator" ||
          diffDeclaredVsApplied(receipt).missing.length
        )
          return unavailable;
      } else if (
        !log
          .split("\n")
          .some(
            (line) =>
              line.includes("operator migrate complete:") &&
              line.includes("migration(s) applied + verified +")
          )
      )
        return unavailable;
    }
    // k3s currently has no full bundle/source annotation. Reporting its image or /version as
    // that missing native identity would invent proof. Preserve all old k3s gates and expose
    // only historical migration observation until its owning source supplies that identity.
    return { ...unavailable, migration: "verified" };
  }
  private checkProvider(
    w: Workload,
    observed: Awaited<
      ReturnType<NonNullable<AkashTxConsolePort["readManagedDefinition"]>>
    >
  ): void {
    const sdl = record(parseYaml(observed.providerSdl)),
      services = record(sdl.services),
      compute = record(record(sdl.profiles).compute),
      deployment = record(sdl.deployment);
    if (
      !same(
        Object.keys(services).sort(),
        w.services.map((s) => s.name).sort()
      ) ||
      !same(Object.keys(compute).sort(), Object.keys(services).sort()) ||
      !same(Object.keys(deployment).sort(), Object.keys(services).sort()) ||
      observed.services.length !== w.services.length
    )
      throw new Error("provider_unavailable");
    for (const service of w.services) {
      const s = record(services[service.name]),
        artifact = w.artifacts.find((a) => a.name === service.artifact),
        resources = record(record(compute[service.name]).resources);
      if (
        s.image !== artifact?.image ||
        commandTemplate(s) !== service.commandTemplate ||
        record(resources.cpu).units !== service.cpuUnits ||
        record(resources.memory).size !== `${service.memoryMi}Mi` ||
        !same(resources.storage, [{ size: `${service.storageMi}Mi` }])
      )
        throw new Error("provider_unavailable");
      const expectedExpose = [
        {
          port: service.port,
          as: service.visibility === "public" ? 80 : service.port,
          ...(service.visibility === "public"
            ? { accept: [w.publicHost], to: [{ global: true }] }
            : {
                to: w.services
                  .filter((x) => x.name !== service.name)
                  .map((x) => ({ service: x.name })),
              }),
        },
      ];
      if (!same(s.expose, expectedExpose))
        throw new Error("provider_unavailable");
      const groups = Object.values(record(deployment[service.name]));
      if (
        groups.length !== 1 ||
        record(groups[0]).profile !== service.name ||
        record(groups[0]).count !== 1
      )
        throw new Error("provider_unavailable");
      const rollout = observed.services.find((r) => r.name === service.name);
      if (
        !rollout ||
        !Number.isSafeInteger(rollout.observedGeneration) ||
        rollout.observedGeneration < 1 ||
        !rollout.currentArtifact ||
        rollout.currentArtifact.generation !== rollout.observedGeneration ||
        rollout.currentArtifact.image !== artifact?.image ||
        [
          rollout.replicas,
          rollout.updatedReplicas,
          rollout.readyReplicas,
          rollout.availableReplicas,
          rollout.total,
          rollout.available,
        ].some((n) => n !== 1)
      )
        throw new Error("provider_unavailable");
      // Compare only the finite PUBLIC topology emitted by the owned assembler.
      // Arbitrary env/secret values are never accepted, compared, hashed or returned.
      const entries = array(s.env ?? []).map((x) => {
        if (typeof x !== "string" || !x.includes("="))
          throw new Error("provider_unavailable");
        const at = x.indexOf("=");
        return [x.slice(0, at), x.slice(at + 1)] as const;
      });
      if (new Set(entries.map(([key]) => key)).size !== entries.length)
        throw new Error("provider_unavailable");
      const topology: Record<string, string> = {
        HOST: service.bindHost,
        HOSTNAME: service.bindHost,
        PORT: String(service.port),
      };
      for (const binding of service.bindings) {
        const target = w.services.find(
          (candidate) => candidate.name === binding.service
        );
        if (
          !target ||
          binding.key in topology ||
          service.secretRefs.some((ref) => ref.key === binding.key)
        )
          throw new Error("provider_unavailable");
        topology[binding.key] = `http://${target.name}:${target.port}`;
      }
      if (service.secretRefs.some((ref) => ref.key in topology))
        throw new Error("provider_unavailable");
      for (const [key, expected] of Object.entries(topology)) {
        const actual = entries.find(([name]) => name === key);
        if (!actual || actual[1] !== expected)
          throw new Error("provider_unavailable");
      }
      const keys = entries.map(([key]) => key);
      if (
        service.secretRefs.some(
          (ref) =>
            !keys.includes(
              ref.key === "LITELLM_VIRTUAL_KEY" &&
                service.runtimeProfile === "cogni-node-app-v1"
                ? "LITELLM_MASTER_KEY"
                : ref.key
            )
        )
      )
        throw new Error("provider_unavailable");
    }
  }
  private async migration(
    input: ComputeReleaseProofInput,
    w: Workload,
    slug: string,
    ns: string,
    signal: AbortSignal
  ): Promise<ProofVerdict> {
    const apps = w.services.filter(
      (s) => s.runtimeProfile === "cogni-node-app-v1"
    );
    if (apps.length === 0) return "verified";
    if (apps.length !== 1) return "unavailable";
    const app = required(apps[0]),
      image = w.artifacts.find((a) => a.name === app.artifact)?.image;
    const digest = input.expected.bundleRef.split("@sha256:")[1];
    if (!digest) return "unavailable";
    const jobName = `migrate-${slug}-${digest.slice(0, 12)}`;
    const job = record(
        await this.kube.json(
          `/apis/batch/v1/namespaces/${ns}/jobs/${segment(jobName)}`,
          signal
        )
      ),
      meta = record(job.metadata),
      labels = record(meta.labels),
      status = record(job.status ?? {});
    if (
      meta.name !== jobName ||
      meta.namespace !== ns ||
      typeof meta.uid !== "string" ||
      meta.deletionTimestamp ||
      labels["cogni.io/node"] !== slug ||
      labels["cogni.io/environment"] !== input.expected.environment ||
      labels["app.kubernetes.io/managed-by"] !== "compute-workload-controller"
    )
      return "unavailable";
    // The Job name carries only 12 digest characters. It cannot by itself prove the
    // full bundle. Missing writer evidence is unavailable, even beside old success logs.
    if (
      record(meta.annotations ?? {})["cogni.io/bundle-digest"] !==
      `sha256:${digest}`
    )
      return "unavailable";
    const conditions = array(status.conditions ?? []);
    if (
      conditions.some(
        (x) => record(x).type === "Failed" && record(x).status === "True"
      )
    )
      return "failed";
    if (
      !conditions.some(
        (x) => record(x).type === "Complete" && record(x).status === "True"
      ) ||
      Number(status.active ?? 0) > 0
    )
      return "running";
    const phases = cogniNodeAppMigrationPhases({
      doltgres: app.secretRefs.some((r) => r.key === "DOLTGRES_URL"),
    });
    const template = record(record(record(job.spec).template).spec),
      containers = [
        ...array(template.initContainers ?? []),
        ...array(template.containers),
      ];
    if (containers.length !== phases.length) return "unavailable";
    // Each native projection must match the fixed writer independently. Job/pod
    // agreement alone cannot prove the effective credentials or CA references.
    const canonicalContainers = (items: unknown[]): boolean => {
      if (items.length !== phases.length) return false;
      return phases.every((phase, i) => {
        const container = record(items[i]),
          sealed = withDatabaseCaTrust(phase.command);
        return (
          container.name === phase.name &&
          container.image === image &&
          same(container.command, sealed.command) &&
          same(container.args, sealed.args) &&
          (container.envFrom === undefined || same(container.envFrom, [])) &&
          same(container.env, [
            { name: "NODE_NAME", value: slug },
            {
              name: "DATABASE_URL",
              valueFrom: {
                secretKeyRef: {
                  name: `${slug}-compute-migration-secrets`,
                  key: phase.databaseUrlSecretKey,
                },
              },
            },
            {
              name: "DATABASE_SSL_CA_CERT",
              valueFrom: {
                secretKeyRef: {
                  name: `${slug}-compute-migration-secrets`,
                  key: "DATABASE_SSL_CA_CERT",
                  optional: true,
                },
              },
            },
          ])
        );
      });
    };
    if (!canonicalContainers(containers)) return "unavailable";
    const pods = list(
      await this.kube.json(
        `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}&limit=9`,
        signal
      )
    );
    const owned = pods
      .map(record)
      .filter((p) =>
        array(record(p.metadata).ownerReferences ?? []).some(
          (o) =>
            record(o).uid === meta.uid &&
            record(o).kind === "Job" &&
            record(o).controller === true
        )
      );
    if (owned.length !== 1) return "unavailable";
    const pod = required(owned[0]),
      podMeta = record(pod.metadata),
      podStatus = record(pod.status),
      podSpec = record(pod.spec);
    if (
      podMeta.namespace !== ns ||
      typeof podMeta.name !== "string" ||
      podMeta.deletionTimestamp ||
      podStatus.phase !== "Succeeded" ||
      !canonicalContainers([
        ...array(podSpec.initContainers ?? []),
        ...array(podSpec.containers),
      ])
    )
      return "unavailable";
    const states = [
      ...array(podStatus.initContainerStatuses ?? []),
      ...array(podStatus.containerStatuses ?? []),
    ].map(record);
    for (const phase of phases) {
      const state = states.find((x) => x.name === phase.name);
      if (
        !state ||
        state.image !== image ||
        record(record(state.state).terminated).exitCode !== 0
      )
        return "unavailable";
      const log = await this.kube.log(
        `/api/v1/namespaces/${ns}/pods/${segment(podMeta.name)}/log?container=${segment(phase.name)}&limitBytes=65536`,
        signal
      );
      if (phase.name === "migrate") {
        const receipt = parseMigrationReceipt(
          log.slice(log.lastIndexOf("COGNI_MIGRATION_RECEIPT_V1"))
        );
        if (
          !receipt ||
          receipt.node !== slug ||
          new Set(receipt.declared).size !== receipt.declared.length ||
          new Set(receipt.applied.map((r) => r.tag)).size !==
            receipt.applied.length ||
          receipt.applied.some((r) => !/^[0-9a-f]{64}$/.test(r.hash)) ||
          diffDeclaredVsApplied(receipt).missing.length > 0
        )
          return "unavailable";
      } else if (
        !log
          .split("\n")
          .some(
            (line) =>
              line.includes(`${slug} migrate complete:`) &&
              line.includes("migration(s) applied + verified +") &&
              (line.includes("owned branch committed") ||
                line.includes("read-only no-op; no journal DDL or commit"))
          )
      )
        return "unavailable";
    }
    return "verified";
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("unavailable");
  return value;
}
