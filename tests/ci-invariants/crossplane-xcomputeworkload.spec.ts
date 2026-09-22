// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/crossplane-xcomputeworkload`
 * Purpose: Pins the XComputeWorkload authority handoff (task.5096) — the composite API and the
 *   Composition that turn the dormant Crossplane substrate into something that can mint a PAID
 *   Akash lease. These assertions exist because every one of them, if violated, costs real
 *   money or leaks a real credential.
 * Scope: Static YAML/text checks; does NOT contact a cluster, a provider, or a wallet. Reads
 *   infra/crossplane/xcomputeworkload and its Argo Application. The Go-template render itself
 *   cannot run here (function-go-templating is a Go binary), so the invariants below are
 *   deliberately the ones provable from the SOURCE.
 * Invariants:
 *   - NO_SECRET_VALUES: every credential on the wire is a provider-http `{{ name:ns:key }}`
 *     placeholder; a literal value in this directory is unrecoverable once it reaches git.
 *   - WIRE_IS_THE_5095_CONTRACT: @contracts/compute.akash-tx.v1 is a zod strictObject, so an
 *     extra key is a permanent 400 rather than a degraded mode.
 *   - KEY_IS_STABLE: the actuator's cogniKey is the wallet-wide idempotence boundary. A key
 *     built from anything that changes per reconcile mints a SECOND PAID LEASE.
 *   - CLOSED_IS_REMOVED: a released lease still resolves to a handle, so `found` alone would
 *     never go false and a deleted XR could never finish deleting.
 *   - NARROWEST_ACTIVATION: exactly one managed type is activated, and it is namespaced.
 * Side-effects: IO (reads repo manifests)
 * Links: story.5016 R2.3, task.5095, task.5096, infra/crossplane/AGENTS.md
 * @public
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const DIR = path.join(REPO_ROOT, "infra/crossplane/xcomputeworkload");

type YamlObject = Record<string, unknown>;

function readYaml(file: string): YamlObject {
  return parse(readFileSync(path.join(DIR, file), "utf8")) as YamlObject;
}

const xrd = readYaml("xrd.yaml");
const composition = readYaml("composition.yaml");
const activation = readYaml("activation-policy.yaml");
const providerConfig = readYaml("provider-config.yaml");
const kustomization = readYaml("kustomization.yaml");
const application = parse(
  readFileSync(
    path.join(
      REPO_ROOT,
      "infra/k8s/argocd/control-plane/candidate-a/crossplane-xcomputeworkload-application.yaml"
    ),
    "utf8"
  )
) as YamlObject;

const compositionSpec = composition.spec as YamlObject;
const pipeline = compositionSpec.pipeline as YamlObject[];
const renderStep = pipeline[0] as YamlObject;
const template = (
  ((renderStep.input as YamlObject).inline as YamlObject).template as string
).trim();

/**
 * The template with its PROSE removed. Several invariants below are negative ("this concept
 * must not appear"), and the surrounding comments necessarily NAME the thing they forbid —
 * asserting against the raw source would pass only while nobody explained themselves.
 */
const templateCode = template
  .replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, "")
  .replace(/^\s*#.*$/gm, "");

const xrdSpec = xrd.spec as YamlObject;
const version = (xrdSpec.versions as YamlObject[])[0] as YamlObject;
const specSchema = (
  (
    ((version.schema as YamlObject).openAPIV3Schema as YamlObject)
      .properties as YamlObject
  ).spec as YamlObject
).properties as YamlObject;
const statusSchema = (
  (
    ((version.schema as YamlObject).openAPIV3Schema as YamlObject)
      .properties as YamlObject
  ).status as YamlObject
).properties as YamlObject;

describe("XComputeWorkload composite API (task.5096)", () => {
  it("publishes a namespaced composite bound to its Composition", () => {
    expect(xrd.apiVersion).toBe("apiextensions.crossplane.io/v2");
    expect(xrdSpec.group).toBe("compute.cogni.io");
    // Namespaced by construction: one paid workload per node per environment namespace,
    // exactly where the legacy CR lived. A cluster-scoped composite would have no env.
    expect(xrdSpec.scope).toBe("Namespaced");
    expect((xrdSpec.names as YamlObject).kind).toBe("XComputeWorkload");
    expect(xrdSpec.defaultCompositionRef).toEqual({
      name: "xcomputeworkload-akash",
    });
    expect(version.name).toBe("v1alpha1");
    expect(version.referenceable).toBe(true);
    expect(compositionSpec.compositeTypeRef).toEqual({
      apiVersion: "compute.cogni.io/v1alpha1",
      kind: "XComputeWorkload",
    });
  });

  it("preserves every legacy contract the port promised", () => {
    // Identity, artifact/digest/source, topology.
    expect(Object.keys(specSchema).sort()).toEqual([
      // task.5132 — WHICH writer mints this lease, split out of the XR namespace. Optional
      // and defaulting to the XR's own namespace, so no existing production XR changes.
      "actuatorNamespace",
      "bootPolicy",
      "bundle",
      "dns",
      "environment",
      "leaseEpoch",
      "leaseGeneration",
      "migration",
      "nodeId",
      "runtime",
      "workload",
    ]);

    // Identity is IMMUTABLE on both axes: a mutable nodeId or environment would let one
    // object silently retarget a different node's paid lease.
    for (const field of ["nodeId", "environment"]) {
      const rules = (specSchema[field] as YamlObject)[
        "x-kubernetes-validations"
      ] as YamlObject[];
      expect(rules.some((rule) => rule.rule === "self == oldSelf")).toBe(true);
    }

    // BUNDLE_REF_IS_DIGEST — a tag is never desired state, for the bundle or its artifacts.
    const bundle = (specSchema.bundle as YamlObject).properties as YamlObject;
    expect((bundle.ref as YamlObject).pattern).toContain("@sha256:");
    const artifactProps = (
      ((bundle.artifacts as YamlObject).items as YamlObject)
        .properties as YamlObject
    ).image as YamlObject;
    expect(artifactProps.pattern).toContain("@sha256:");

    const service = (
      (
        ((specSchema.workload as YamlObject).properties as YamlObject)
          .services as YamlObject
      ).items as YamlObject
    ).properties as YamlObject;
    // resources + runtime profile + command/args + bindings all survive the port.
    for (const field of [
      "cpuUnits",
      "memoryMi",
      "storageMi",
      "runtimeProfile",
      "command",
      "args",
      "bindings",
      "bindHost",
      "port",
      "visibility",
      "secretRefs",
    ]) {
      expect(service).toHaveProperty(field);
    }

    // VALUE-FREE secret refs: `key` is the ONLY property an item may carry. A `value` here
    // would put a credential in git and in every Argo diff forever.
    const refItem = (service.secretRefs as YamlObject).items as YamlObject;
    expect(Object.keys(refItem.properties as YamlObject)).toEqual(["key"]);
    expect(refItem.required).toEqual(["key"]);
  });

  it("owns BOOT_SLO_OR_CLOSE, which task.5095 explicitly left unowned", () => {
    const boot = (specSchema.bootPolicy as YamlObject).properties as YamlObject;
    const deadline = boot.bootDeadlineSeconds as YamlObject;
    expect(deadline.default).toBe(1800);
    const onDeadline = boot.onDeadline as YamlObject;
    // Hold keeps paying on purpose and says so; Close stops the burn. Defaulting to Close
    // would silently reclaim a production workload, so the SAFE default is the expensive one.
    expect(onDeadline.enum).toEqual(["Hold", "Close"]);
    expect(onDeadline.default).toBe("Hold");

    // The give-up path must actually be wired, not merely declared.
    expect(template).toContain("$closeForBudget");
    expect(template).toContain("BootDeadlineClosed");
    expect(template).toContain("BootDeadlineExceeded");
    // Only a workload that NEVER served may be closed for budget.
    expect(template).toContain(
      '$neverServed := and (not $serving) (eq $prevSha "")'
    );
  });

  it("declares the empty-birth schema policy WITHOUT claiming it gates payment", () => {
    const migration = specSchema.migration as YamlObject;
    const policy = (migration.properties as YamlObject).policy as YamlObject;
    // task.5135: `RequireBeforeServing` is the default. `RequireBeforeTransaction` remains
    // SERVED as a deprecated alias for the zero-downtime field migration — XRs already on
    // deploy refs carry it, and rejecting them would wedge the fleet mid-rollout.
    expect(policy.enum).toEqual([
      "RequireBeforeServing",
      "RequireBeforeTransaction",
      "Skip",
    ]);
    expect(policy.default).toBe("RequireBeforeServing");

    // THE API MUST NOT LIE. A field that no longer gates payment may not describe itself as a
    // precondition of one — a stale description is how the next reader re-derives the coupling.
    const description = String(migration.description);
    expect(description).toMatch(/IT DOES NOT GATE PAYMENT/);
    // The retired claim, in the present tense it used to be written in.
    expect(description).not.toMatch(/is REFUSED until/i);
    expect(description).not.toMatch(/before its lease does/i);
  });

  it("publishes the release step's phase in status, bounded to the four it can be", () => {
    // The migration outcome is an OBSERVATION on the composite, which is the whole shape of
    // the fix: it is something an operator can read, not something a wallet can be refused by.
    const phase = (
      (statusSchema.migration as YamlObject).properties as YamlObject
    ).phase as YamlObject;
    expect(phase.enum).toEqual([
      "succeeded",
      "running",
      "failed",
      "unavailable",
    ]);
  });
});

describe("XComputeWorkload Composition (task.5096)", () => {
  it("delegates all generic reconciliation to pinned OSS functions", () => {
    expect(compositionSpec.mode).toBe("Pipeline");
    expect(
      pipeline.map((step) => (step.functionRef as YamlObject).name)
    ).toEqual(["function-go-templating", "function-auto-ready"]);

    // Both functions must actually be installed by the dormant-substrate task; a Composition
    // referencing an uninstalled function fails at render with no managed resource created.
    const installed = readFileSync(
      path.join(REPO_ROOT, "infra/crossplane/install/packages/functions.yaml"),
      "utf8"
    );
    expect(installed).toContain("function-go-templating");
    expect(installed).toContain("function-auto-ready");
  });

  it("enforces the identity rule an XRD schema structurally cannot", () => {
    // The legacy CRD's top-level `metadata.name == spec.nodeId` rule has no home in an XRD
    // (only spec/status may be described), so the render refuses instead. Failing the render
    // creates NO managed resource, which is why the fallback is safe: nothing is spent.
    expect(template).toContain("{{- if ne $name $spec.nodeId }}");
    expect(template).toContain("{{- fail (printf");
    expect(template).toContain('{{- if ne (printf "cogni-%s" $env) $ns }}');
  });

  it("sends the actuator its exact strict-contract wire shape", () => {
    // @contracts/compute.akash-tx.v1 accepts EXACTLY {cogniKey, environment, spec}; the spec
    // is `{name, services[]}`. An extra key is a 400 forever, never a partially-honoured call.
    expect(template).toContain(
      '$payload := dict "cogniKey" $cogniKey "environment" $env "identity" $identity "spec" (dict "name" $slug "services" $services)'
    );
    // The four bounded ops map 1:1 onto provider-http's four actions — no Cogni code decides
    // WHEN to act.
    for (const [action, route] of [
      ["OBSERVE", "/v1/akash/observe"],
      ["CREATE", "/v1/akash/create"],
      ["UPDATE", "/v1/akash/update"],
      ["REMOVE", "/v1/akash/delete"],
    ]) {
      expect(template).toContain(`action: ${action}`);
      expect(template).toContain(route);
    }
    // The serving probe is the exact desired SHA, never a tag or a "latest".
    expect(template).toContain("expectedSourceSha:");
    expect(template).toContain("$desiredSha := $spec.bundle.source.sha");
  });

  it("keeps the idempotence key stable for the life of the workload", () => {
    // namespace + name are immutable (name == nodeId). The ONLY varying component is
    // spec.leaseGeneration, which nothing bumps implicitly — a key that changed per reconcile
    // would report "no existing resource" after a promote and mint a SECOND PAID LEASE.
    expect(template).toContain(
      '$cogniKey := printf "xcw:%s:%s:%d" $ns $name $leaseGeneration'
    );
    // Scoped to the KEY, not the whole template: task.5103 legitimately reads
    // metadata.generation for the spend receipt's provenance. What must never happen is that
    // per-reconcile value leaking into the IDEMPOTENCE key, where it would report "no existing
    // resource" after a promote and mint a SECOND PAID LEASE. The two uses are opposites — one
    // records which revision asked, the other must not vary at all.
    const keyInputs = ["$ns", "$name", "$leaseGeneration"];
    const keyLiteral =
      /\$cogniKey := printf "[^"]*"([^}]*)\}\}/.exec(templateCode)?.[1] ?? "";
    expect(keyLiteral.trim().split(/\s+/)).toEqual(keyInputs);
    // ZERO-DOWNTIME WIRE RENAME (task.5105 -> task.5122). NOTHING writes leaseEpoch any more
    // (see compute-workload-manifest.test.ts "never writes the deprecated leaseEpoch alias"),
    // but XRs committed on deploy/<env>-<node> refs BEFORE the rename still carry it, so the
    // additive schema must keep accepting it and the Composition must keep reading it as a
    // last-resort fallback while preferring the canonical name. This is what prevents toks5's
    // intended generation 1 from ever becoming 0 regardless of which deploy lane moves first.
    expect(templateCode).toContain(
      '$leaseGeneration := int (dig "leaseEpoch" 0 $spec)'
    );
    expect(templateCode).toContain(
      '$hasLeaseEpoch := hasKey $spec "leaseEpoch"'
    );
    expect(templateCode).toContain(
      '$hasLeaseGeneration := hasKey $spec "leaseGeneration"'
    );
    expect(templateCode).toContain(
      'if and $hasLeaseEpoch $hasLeaseGeneration (ne (int (get $spec "leaseEpoch")) (int (get $spec "leaseGeneration")))'
    );
    expect(templateCode).toContain(
      "spec.leaseEpoch and spec.leaseGeneration disagree; refusing to choose an idempotence key"
    );
    expect(
      templateCode.indexOf(
        "spec.leaseEpoch and spec.leaseGeneration disagree; refusing to choose an idempotence key"
      )
    ).toBeLessThan(templateCode.indexOf("$cogniKey := printf"));
    expect(templateCode).toContain(
      '$leaseGeneration = int (get $spec "leaseGeneration")'
    );
    expect(templateCode).not.toContain("resourceVersion");
    const leaseGeneration = specSchema.leaseGeneration as YamlObject;
    expect(leaseGeneration.default).toBeUndefined();
    const leaseEpoch = specSchema.leaseEpoch as YamlObject;
    expect(leaseEpoch.default).toBeUndefined();
    expect(leaseEpoch.description).toContain("DEPRECATED read-side alias");
    // The alias must never become permanent furniture: its own description has to carry the
    // condition under which it is deleted, and name the owning work item.
    expect(leaseEpoch.description).toContain("REMOVAL GATE");
    expect(leaseEpoch.description).toContain("task.5121");
  });

  it("resolves the WRITER from its own field while the idempotence key keeps the XR namespace", () => {
    // task.5132. The XR namespace used to answer three different questions at once: which
    // key identifies this allocation, which Service mints it, and which secret authorises
    // that call. A real node's pre-prod lane must bill the PRODUCTION account (NS3) while
    // keeping a key DISTINCT from its own production lease — impossible while one value
    // drove both. Reusing the production key would hand the actuator a settled key and it
    // would refuse to mint: the right refusal for the wrong reason.
    // `templateCode` has the PROSE stripped — load-bearing here, because the comment that
    // explains this split necessarily names the very strings the negatives forbid.

    // The key is still namespace-derived — that is what keeps lanes from colliding.
    expect(templateCode).toContain(
      'printf "xcw:%s:%s:%d" $ns $name $leaseGeneration'
    );

    // The writer lookup and its auth ref move together. Splitting only one of them would
    // dial the right Service with the wrong secret.
    expect(templateCode).toContain(
      'printf "http://akash-tx-actuator.%s.svc.cluster.local:8080" $writerNs'
    );
    expect(templateCode).toContain(
      'akash-tx-actuator-auth:%s:token }}" $writerNs'
    );

    // Neither may keep reading $ns, or the decoupling is cosmetic.
    expect(templateCode).not.toContain(
      'printf "http://akash-tx-actuator.%s.svc.cluster.local:8080" $ns'
    );
    expect(templateCode).not.toContain(
      'akash-tx-actuator-auth:%s:token }}" $ns'
    );

    // Default is the XR's own namespace: every existing production XR renders unchanged.
    expect(templateCode).toContain("$writerNs := $ns");

    // Optional in the schema — an XR that says nothing keeps the legacy behaviour.
    const actuatorNamespace = specSchema.actuatorNamespace as YamlObject;
    expect(actuatorNamespace.default).toBeUndefined();
  });

  it("preserves the replacement generation across every mixed-revision bridge shape", () => {
    /** Model API-server top-level defaults from the checked-in XRD schema. */
    const admitWithSchemaDefaults = (
      desired: Readonly<Record<string, number>>
    ): Record<string, number> => {
      const admitted = { ...desired };
      for (const [field, rawSchema] of Object.entries(specSchema)) {
        const fieldSchema = rawSchema as YamlObject;
        if (
          !Object.hasOwn(admitted, field) &&
          fieldSchema.default !== undefined
        ) {
          admitted[field] = fieldSchema.default as number;
        }
      }
      return admitted;
    };
    /** Mirrors the canonical-first fallback expression pinned in the preceding test. */
    const renderCogniKey = (
      desired: Readonly<Record<string, number>>
    ): string | undefined => {
      const admitted = admitWithSchemaDefaults(desired);
      if (
        Object.hasOwn(admitted, "leaseEpoch") &&
        Object.hasOwn(admitted, "leaseGeneration") &&
        admitted.leaseEpoch !== admitted.leaseGeneration
      ) {
        return undefined;
      }
      const generation = Object.hasOwn(admitted, "leaseGeneration")
        ? admitted.leaseGeneration
        : (admitted.leaseEpoch ?? 0);
      return `xcw:cogni-production:toks5:${generation}`;
    };

    expect([
      renderCogniKey({ leaseEpoch: 1 }), // pre-rename XR still on a deploy ref
      renderCogniKey({ leaseGeneration: 1 }), // what the materializer writes from task.5122 on
      renderCogniKey({ leaseEpoch: 1, leaseGeneration: 1 }), // a bridge-era dual-written XR
    ]).toEqual([
      "xcw:cogni-production:toks5:1",
      "xcw:cogni-production:toks5:1",
      "xcw:cogni-production:toks5:1",
    ]);
    expect(renderCogniKey({})).toBe("xcw:cogni-production:toks5:0");
    // Corrupt/mid-edit dual fields fail before a Request/key exists. Picking either side could
    // mint a paid replacement the other field did not authorize.
    expect(
      renderCogniKey({ leaseEpoch: 1, leaseGeneration: 2 })
    ).toBeUndefined();
  });

  it("treats a closed lease as removed so a deleted XR can finish deleting", () => {
    // The actuator still resolves a RELEASED key to its handle (state `closed`), so a naive
    // `found == false` check would leave the Request — and therefore the XR — undeletable.
    expect(template).toContain(
      '(.response.body.found == false) or (.response.body.resource.state == "closed")'
    );
    // The namespaced Request has NO deletionPolicy field; management defaults to ["*"],
    // which includes Delete. Orphan is never right for a resource that costs money.
    expect(templateCode).not.toMatch(/^\s*deletionPolicy:/m);
  });

  it("composes only the namespaced managed type against a credential-free config", () => {
    expect(template).toContain("apiVersion: http.m.crossplane.io/v1alpha2");
    expect(templateCode).not.toContain("apiVersion: http.crossplane.io/");
    expect(template).toContain("kind: ClusterProviderConfig");
    expect(template).toContain("name: cogni-http");
  });

  it("puts no secret value on the wire", () => {
    // Every credential is a provider-http placeholder resolved at request time from the
    // environment's existing ESO-managed Secret, and masked in spec, status and provider logs.
    const placeholders =
      template.match(/\{\{ [a-z0-9-]+:%s:[A-Z_]+ \}\}/g) ?? [];
    expect(placeholders.length).toBeGreaterThan(0);
    // The generic lowering of a declared secretRef, and the two named operator credentials.
    expect(template).toContain(
      '$ref := printf "{{ %s:%s:%s }}" $secretName $ns .key'
    );
    expect(template).toContain(
      '$secretName := printf "%s-compute-env-secrets" $slug'
    );
    expect(template).toContain("CLOUDFLARE_API_TOKEN }}");
    expect(template).toContain("akash-tx-actuator-auth:%s:token");

    // Nothing that looks like a materialized credential may appear anywhere in the directory.
    for (const file of [
      "xrd.yaml",
      "composition.yaml",
      "provider-config.yaml",
      "activation-policy.yaml",
    ]) {
      const text = readFileSync(path.join(DIR, file), "utf8");
      expect(text).not.toMatch(
        /\b(?:eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,})\b/
      );
      expect(text).not.toMatch(/postgres(?:ql)?:\/\/[^\s"']*:[^\s"'@]+@/);
    }
  });

  it("preserves the runtime profile, bindings and log identity of the legacy lowering", () => {
    // Port of legacyCogniAppEnv(): the virtual key is RENAMED, never also passed verbatim.
    expect(template).toContain('$_ := set $e "LITELLM_MASTER_KEY" $ref');
    expect(template).toContain('eq .key "LITELLM_VIRTUAL_KEY"');
    // bindings -> sibling service URLs.
    expect(template).toContain('printf "http://%s:%d" $target');
    // Application-log identity (bug.5127) — the stream labels the node transport emits.
    expect(template).toContain("LOKI_PUSH_SOURCE");
    expect(template).toContain('$_ := set $e "COGNI_NODE_ID" $spec.nodeId');
    // Exactly-one-public-service exposure.
    expect(template).toContain('$public := eq $svc.visibility "public"');
  });
});

describe("XComputeWorkload migration decoupling (task.5135)", () => {
  /**
   * Scope to the LEASE request: the composition also renders a Cloudflare Request whose
   * mappings share the same action names, and a regex over the whole template would silently
   * assert against DNS instead of the thing that spends money.
   */
  function leaseMappings(): Record<string, string> {
    const leaseBlock = template.slice(
      template.indexOf("composition-resource-name: akash-lease"),
      template.indexOf("composition-resource-name: dns-record")
    );
    expect(leaseBlock.length).toBeGreaterThan(0);
    return Object.fromEntries(
      [
        ...leaseBlock.matchAll(
          /- action: (\w+)\n([\s\S]*?)(?=\n\s+- action: |\n\s+expectedResponseCheck:)/g
        ),
      ].map((m) => [m[1], m[2]])
    ) as Record<string, string>;
  }

  it("carries the migration on OBSERVE — the UNPAID tick — and nowhere else", () => {
    // THE invariant. bug.5140 put the migration on create/update, which made a database a
    // precondition of renting a computer; node toks5 then held a valid XR with a valid digest,
    // never reached the actuator, and existed in no environment while `akash-lease` reported
    // "not yet ready" 1044 times. Observe spends nothing, so it is where the step belongs.
    const mappings = leaseMappings();
    expect(Object.keys(mappings).sort()).toEqual([
      "CREATE",
      "OBSERVE",
      "REMOVE",
      "UPDATE",
    ]);
    expect(mappings.OBSERVE).toContain(
      "migration: .payload.body.migrationStep"
    );
    // WHOSE database — stated, never inferred from the actuator's own deployment.
    expect(mappings.OBSERVE).toContain("workload: .payload.body.spec.name");
    expect(mappings.OBSERVE).toContain(
      "environment: .payload.body.environment"
    );
    // The release step must NEVER reach a paid action.
    expect(mappings.CREATE).not.toContain("migrationStep");
    expect(mappings.UPDATE).not.toContain("migrationStep");
    expect(mappings.REMOVE).not.toContain("migration");
  });

  it("enumerates the paid body instead of posting the payload verbatim", () => {
    // CREATE used to be `.payload.body`, which meant every field added for any other action
    // leaked onto the wire that spends money — and the create contract is a strict object that
    // 400s on an unknown key. `migrationStep` is exactly such a field.
    const mappings = leaseMappings();
    expect(mappings.CREATE).toContain("cogniKey: .payload.body.cogniKey");
    expect(mappings.CREATE).toContain("spec: .payload.body.spec");
    expect(mappings.CREATE).not.toMatch(/body: \|\n\s+\.payload\.body\s*$/);
  });

  it("renders the release step only for a workload that actually has a database", () => {
    // The empty dict is the DEFAULT accumulator, so the only way to reach the step is to
    // satisfy its condition — a template bug fails toward "no migration", never toward one
    // that runs against a workload with no schema to migrate.
    expect(template).toContain("{{- $migrationStep := dict }}");
    expect(template).toContain(
      '{{- if and (eq $migrationPolicy "RequireBeforeServing") (ne $appImage "") }}'
    );
    expect(template).toContain(
      '$migrationStep = dict "profile" "cogni-node-app-v1" "bundleDigest" $bundleDigest "image" $appImage "doltgres" $appDoltgres'
    );
    // Presence IS the policy: no `Skip` member travels on the step wire at all.
    expect(templateCode).not.toMatch(
      /\$migrationStep\s*=?:?=?\s*dict "policy"/
    );
  });

  it("keeps the deprecated lowering only for XRs not yet rematerialized", () => {
    // Zero-downtime, the same posture leaseEpoch → leaseGeneration uses: an XR already on a
    // deploy ref carries `RequireBeforeTransaction` and may be reconciled against a
    // pre-task.5135 actuator that REQUIRES the field. Dropping it would 400 the fleet.
    expect(template).toContain(
      '{{- if eq $migrationPolicy "RequireBeforeTransaction" }}'
    );
    expect(template).toContain(
      '{{- if $hasLegacyMigration }}{{ $_ := set $payload "migration" $legacyMigration }}{{ end }}'
    );
    // The DEFAULT policy is the new one, so an XR that states nothing gets the decoupled path.
    expect(template).toContain(
      '$migrationPolicy := dig "migration" "policy" "RequireBeforeServing" $spec'
    );
  });

  it("surfaces a failed migration as a NAMED, terminal status reason", () => {
    // The loudness half of the fix. A migration that will never succeed must not hide behind a
    // retryable refusal's "Progressing" — that is what an indefinite silent stall looks like.
    expect(template).toContain(
      '$migrationFailed := eq $migrationPhase "failed"'
    );
    expect(template).toContain("{{- else if $migrationFailed }}");
    expect(template).toContain('$failReason = "MigrationFailed"');
    // Must satisfy the XRD's status.failure.reason pattern, or the write is rejected by the
    // CRD and the very failure this branch exists to announce becomes invisible again.
    expect("MigrationFailed").toMatch(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
    // A terminal refusal still outranks it; a retryable one no longer does.
    expect(template).toContain(
      '{{- else if and (ne $refusalCode "") (not $refusalRetryable) }}'
    );
  });

  it("lowers each fact from the one place that owns it", () => {
    // bundleDigest is the digest of the BUNDLE; image is the app SERVICE's artifact. They are
    // different fields and are routinely different digests — conflating them would migrate the
    // wrong image.
    expect(template).toContain(
      '$bundleDigest := regexFind "sha256:[0-9a-f]{64}$" $spec.bundle.ref'
    );
    expect(template).toContain(
      "{{- if $isApp }}{{ $appImage = $image }}{{ end }}"
    );
    expect(template).toContain(
      '{{- if and $isApp (eq .key "DOLTGRES_URL") }}{{ $appDoltgres = true }}{{ end }}'
    );
    // A ref with no digest fails the render rather than sending a request that cannot be honoured.
    expect(template).toContain("has no sha256 digest to migrate against");
  });

  it("never puts a migration command on the wire", () => {
    // `profile` NAMES a command set the actuator owns. A caller-supplied command would let
    // anyone who can reach the actuator run an arbitrary container against the environment's
    // database under its service account.
    const literals = [
      ...templateCode.matchAll(
        /\$(?:migrationStep|legacyMigration)\s*(?::?=)\s*dict ([^}]*)/g
      ),
    ].map((m) => m[1] as string);
    // Two empty accumulators + the step + the deprecated union's two branches.
    expect(literals.length).toBe(5);
    for (const literal of literals) {
      const keys = [...literal.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]);
      for (const key of keys) {
        expect([
          "policy",
          "Skip",
          "RequireBeforeTransaction",
          "profile",
          "cogni-node-app-v1",
          "bundleDigest",
          "image",
          "doltgres",
        ]).toContain(key);
      }
      expect(literal).not.toMatch(/command|args|phases|script/);
    }
  });
});

describe("XComputeWorkload spend attribution (task.5103)", () => {
  it("states who consumes the infrastructure on every mutation", () => {
    // AkashTxCreateInputSchema and AkashTxUpdateInputSchema BOTH require `identity`. An update
    // mints no lease, but it still mutates a PAID resource, so it says whose it is.
    expect(template).toContain('"identity" $identity');
    const leaseBlock = template.slice(
      template.indexOf("composition-resource-name: akash-lease"),
      template.indexOf("composition-resource-name: dns-record")
    );
    const mappings = Object.fromEntries(
      [
        ...leaseBlock.matchAll(
          /- action: (\w+)\n([\s\S]*?)(?=\n\s+- action: |\n\s+expectedResponseCheck:)/g
        ),
      ].map((m) => [m[1], m[2]])
    );
    // CREATE posts the payload verbatim; UPDATE is hand-built and must carry it explicitly.
    expect(mappings.CREATE).toContain(".payload.body");
    expect(mappings.UPDATE).toContain("identity: .payload.body.identity");
    // Observe and delete are strict objects with NO identity field — sending one is a 400.
    expect(mappings.OBSERVE).not.toContain("identity");
    expect(mappings.REMOVE).not.toContain("identity");
  });

  it("sends exactly the three contract keys", () => {
    // AkashTxIdentitySchema is a strictObject: an extra key is a 400, never a dropped field.
    // Deliberately NOT here, per the contract: wallet scope (custody — a caller must never be
    // able to name a wallet), billing account, DAO address, and actor.
    const literal = /\$identity := dict ([^}]*)/.exec(templateCode)?.[1] ?? "";
    expect(literal).not.toBe("");
    const keys = [...literal.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]);
    expect(keys).toEqual(["nodeId", "compositeUid", "compositeGeneration"]);
    // nodeId comes from the SPEC, which the identity gate has already proven equal to
    // metadata.name — so the identity the cluster uses and the one the ledger records cannot
    // drift. Deriving it from the slug or the cogniKey instead would be exactly the inference
    // the actuator refuses to do.
    expect(literal).toContain("$spec.nodeId");
  });

  it("never fabricates a revision it did not observe", () => {
    // A defaulted compositeGeneration of 1 would record a revision that never happened, and the
    // receipt's CHECK (> 0) would happily accept the lie — a fabricated provenance is worse than
    // a refusal because it is indistinguishable from a real one after the fact.
    expect(template).toContain('{{- if not (hasKey $meta "generation") }}');
    expect(template).toContain(
      "refusing to fabricate a revision that was never observed"
    );
    expect(template).toContain("{{- $generation := int $meta.generation }}");
    expect(template).toContain("{{- if lt $generation 1 }}");
    // No default anywhere on the generation or the uid: `dig`'s fallback is the defaulting
    // idiom used elsewhere in this template, and it must not appear for either.
    expect(templateCode).not.toMatch(/dig "generation"/);
    expect(templateCode).not.toMatch(/dig "metadata" "generation"/);
    // The uid fallback exists only to DETECT absence; it is immediately refused, never sent.
    expect(template).toContain('{{- $compositeUid := dig "uid" "" $meta }}');
    expect(template).toContain('{{- if eq $compositeUid "" }}');
  });

  it("treats an identity conflict as terminal, not as something to retry", () => {
    // The actuator maps identity_conflict to 422, not 409, because no number of retries changes
    // who consumed a resource. That must fall out of the existing status-driven mapping rather
    // than need a special case — 422 is neither 409 nor >= 500, so it reports Failed.
    expect(template).toContain(
      "$refusalRetryable := or (eq $respStatus 409) (ge $respStatus 500)"
    );
    expect("identity_conflict").toMatch(
      new RegExp(
        (
          ((statusSchema.failure as YamlObject).properties as YamlObject)
            .reason as YamlObject
        ).pattern as string
      )
    );
  });
});

describe("XComputeWorkload refusal observability (bug.5115)", () => {
  const failureProps = (statusSchema.failure as YamlObject)
    .properties as YamlObject;
  const reasonPattern = new RegExp(
    (failureProps.reason as YamlObject).pattern as string
  );

  it("surfaces the actuator's stable refusal code on the composite", () => {
    // A refusal a caller cannot see is a bug: a wallet block that only reached provider logs
    // was invisible for hours. A non-2xx actuator body carries `code`; an observation body
    // never does, so the two can never be confused.
    expect(template).toContain('$refusalCode := dig "code" "" $resp');
    expect(template).toContain("{{- $failReason = $refusalCode }}");
    // status.failure.message is maxLength 256; an over-long message is rejected by the API
    // server and takes the whole status write — and the refusal — down with it.
    expect(failureProps.message).toMatchObject({ maxLength: 256 });
    expect(template).toContain("$failMessage = substr 0 256 $refusalMessage");
  });

  it("derives retryability from the HTTP status, not a table of codes", () => {
    // The actuator documents 409 as "conflict, come back later with the same key" and 5xx as
    // unproven; every other 4xx is terminal for this desired state. A code table here would
    // need editing every time the actuator learns a refusal — the exact coupling that
    // status.failure.reason is a patterned string rather than an enum to avoid.
    expect(template).toContain(
      "$refusalRetryable := or (eq $respStatus 409) (ge $respStatus 500)"
    );
    // Split into two branches by task.5135 so a TERMINAL migration failure can be reported
    // between them: it must not outrank a terminal refusal, and must outrank a retryable one.
    expect(template).toContain(
      '{{- else if and (ne $refusalCode "") (not $refusalRetryable) }}'
    );
    expect(template).toContain('{{- else if ne $refusalCode "" }}');
    // Every code the actuator can emit must satisfy the XRD's reason pattern, or the status
    // write is rejected and the refusal is invisible again.
    for (const code of [
      // The three `migration_*` codes were REMOVED with task.5135 — a database can no longer
      // refuse a paid request, so there is no migration refusal left to render.
      "wallet_allocation_blocked",
      "allocation_unresolved",
      "allocation_ambiguous",
      "outcome_unknown",
      "provider_rejected",
      "provider_unavailable",
      "ledger_unavailable",
      "not_found",
      "invalid_request",
      "unauthorized",
    ]) {
      expect(code).toMatch(reasonPattern);
    }
  });

  it("carries the lease handle through a refusal, but never invents one", () => {
    // provider-http overwrites status.response.body with the ERROR body of a failed mutation,
    // so a 4xx on UPDATE leaves the render with no observation — and the naive result is that
    // status.resource.id vanishes at the exact moment an operator needs the lease handle to
    // diagnose the failure. A refusal is "we did not get to look", not "the lease is gone".
    expect(template).toContain(
      '$prevResource := dig "status" "resource" (dict) $xr'
    );
    expect(template).toContain(
      '{{- else if and (ne $refusalCode "") $prevResource }}'
    );
    // The latch is guarded on the REFUSAL, not merely on `found == false`: a genuine
    // `found: false` observation really does mean gone, and advertising a stale handle there
    // would be a lie.
    expect(template).not.toContain("{{- else if $prevResource }}");
  });

  it("never lets a refusal mask a spend decision", () => {
    // BOOT_SLO_OR_CLOSE decides whether money keeps being spent. A transient refusal must not
    // displace it, so the refusal branch comes strictly AFTER both deadline branches.
    const chain = template.slice(
      template.lastIndexOf('{{- $phase := "Progressing" }}')
    );
    const order = [
      "BootDeadlineClosed",
      "BootDeadlineExceeded",
      "$refusalCode",
    ].map((marker) => chain.indexOf(marker));
    expect(order.every((index) => index > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("XComputeWorkload authority handoff (task.5096)", () => {
  it("activates exactly one namespaced managed type", () => {
    expect(activation.apiVersion).toBe("apiextensions.crossplane.io/v1alpha1");
    expect(activation.kind).toBe("ManagedResourceActivationPolicy");
    // No wildcard. The cluster-scoped Request stays inactive: desired state for a paid
    // workload is namespaced by construction.
    expect((activation.spec as YamlObject).activate).toEqual([
      "requests.http.m.crossplane.io",
    ]);
  });

  it("gives provider-http no standing authority of its own", () => {
    expect(providerConfig.kind).toBe("ClusterProviderConfig");
    expect((providerConfig.spec as YamlObject).credentials).toEqual({
      source: "None",
    });
  });

  it("installs the API but commits no desired state", () => {
    expect(kustomization.resources).toEqual([
      "activation-policy.yaml",
      "provider-config.yaml",
      "xrd.yaml",
      "composition.yaml",
    ]);
  });

  it("is flightable on candidate-a before it is merged", () => {
    const source = (application.spec as YamlObject).source as YamlObject;
    // main would make the control plane un-flightable — the whole point of candidate-a is to
    // prove a control-plane change BEFORE it lands.
    expect(source.targetRevision).toBe("deploy/candidate-a-control-plane");
    expect(source.path).toBe("infra/crossplane/xcomputeworkload");
    expect((application.spec as YamlObject).destination).toEqual({
      server: "https://kubernetes.default.svc",
      namespace: "crossplane-system",
    });
  });
});

describe("XComputeWorkload public reachability (bug.5152)", () => {
  // Everything from the Cloudflare Request to the end of the template. Sliced from the
  // prose-stripped source because the assertions below are mostly negative, and the comments
  // that justify them necessarily name the thing they forbid.
  const dnsBlock = templateCode.slice(
    templateCode.indexOf("composition-resource-name: dns-record")
  );

  it("adopts the host by NAME, never by record type", () => {
    expect(dnsBlock.length).toBeGreaterThan(0);
    // Cloudflare's list API FILTERS, it does not merge: `?type=CNAME&name=<host>` over a host
    // held by a legacy A record answers with an EMPTY array, isRemovedCheck reads that as "the
    // record does not exist", and CREATE then loops forever on the 400 Cloudflare returns for a
    // second record on an exclusive name — while the stale record keeps serving 502.
    expect(dnsBlock).toContain('"?name=" + .payload.body.name');
    expect(dnsBlock).not.toMatch(/\?type=/);
  });

  it("adopts only the address types it is allowed to own", () => {
    expect(templateCode).toContain(
      'map(select(.type == "A" or .type == "AAAA" or .type == "CNAME"))'
    );
    // A name held by anything else filters to an empty set, so the request fails LOUDLY on
    // CREATE rather than silently converting a record this composite never owned — the same
    // line the bespoke adapter draws with DnsOwnershipChanged.
    expect(templateCode).not.toMatch(/select\(\.type == "(MX|TXT|NS|SRV|CAA)"/);
  });

  it("publishes a PROXIED CNAME, because the provider's certificate is not ours", () => {
    // The Akash provider ingress serves `*.ingress.zencloud.eu`. A grey-cloud CNAME from the
    // cogni name to it fails TLS on a subject-name mismatch before a byte of HTTP is exchanged,
    // so an unproxied record resolves and STILL cannot be reached.
    expect(dnsBlock).not.toContain("proxied: false");
    // CREATE body + UPDATE body.
    expect(dnsBlock.match(/proxied: true/g)?.length).toBe(2);
    // ...and drift back to grey-cloud is not "up to date".
    expect(dnsBlock).toContain("| .[0].proxied) == true");
  });

  it("reports published as an observation, never as an echo of the intent", () => {
    // `published` used to restate that spec.dns was set, so an XR whose Cloudflare write had
    // failed since birth still claimed its hostname was published. The one field an operator
    // reads to answer "is this node reachable by NAME?" must be able to say no.
    expect(templateCode).toContain("published: {{ $dnsPublished }}");
    expect(templateCode).not.toContain("published: {{ if $dns }}");
    expect(templateCode).toContain('index $observedResources "dns-record"');
  });
});

/**
 * CATALOG_CARRIES_ONE_NAME (task.5122). The catalog is the SSOT for the replacement counter,
 * and the resolver (`resolveNodeLeaseGeneration`) reads ONLY `lease_generation` with NO legacy
 * fallback -- a row left on the old key would therefore resolve silently to 0, which for a node
 * whose lease already settled under key `:0` means the actuator refuses it forever and the node
 * stays dead. Pin the purge here rather than trusting a one-time grep.
 */
describe("catalog lease generation naming", () => {
  const CATALOG_DIR = path.join(REPO_ROOT, "infra/catalog");
  const rows = readdirSync(CATALOG_DIR).filter(
    (f) => f.endsWith(".yaml") && !f.startsWith("_")
  );

  it("has catalog rows to check", () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it("uses lease_generation and never the deprecated lease_epoch key", () => {
    for (const file of rows) {
      const raw = readFileSync(path.join(CATALOG_DIR, file), "utf8");
      const row = parse(raw) as YamlObject;
      expect(
        Object.hasOwn(row, "lease_epoch"),
        `${file} still declares lease_epoch`
      ).toBe(false);
    }
  });

  it("declares lease_generation in the catalog schema, not lease_epoch", () => {
    const schema = JSON.parse(
      readFileSync(path.join(CATALOG_DIR, "_schema.json"), "utf8")
    ) as { properties: Record<string, unknown> };
    expect(Object.hasOwn(schema.properties, "lease_generation")).toBe(true);
    expect(Object.hasOwn(schema.properties, "lease_epoch")).toBe(false);
  });

  /**
   * THE VALUE IS THE MONEY (bug.5192). toks5 production's generation-0 receipt is terminally
   * settled, so its row MUST resolve to key suffix `:1`. The rename may not move a VALUE: a
   * changed suffix answers "no existing resource" and mints a SECOND PAID LEASE, and a suffix
   * that reverted to 0 re-deads the node against a key the actuator already spent.
   */
  it("keeps toks5 production on replacement generation 1 when that fleet row exists", () => {
    const toks5Path = path.join(CATALOG_DIR, "toks5.yaml");
    if (!existsSync(toks5Path)) return;

    const toks5 = parse(readFileSync(toks5Path, "utf8")) as {
      lease_generation?: Record<string, number>;
    };
    expect(toks5.lease_generation?.production).toBe(1);
  });
});
