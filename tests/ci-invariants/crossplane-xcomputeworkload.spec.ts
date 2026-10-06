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
 *   - KEY_IS_BOUNDED: the actuator's cogniKey is the wallet-wide idempotence boundary. Its base
 *     never changes per reconcile; only a terminal actor read-back may select one of three
 *     deterministic recovery children.
 *   - CLOSED_IS_REMOVED: a released lease still resolves to a handle, so `found` alone would
 *     never go false and a deleted XR could never finish deleting.
 *   - NARROWEST_ACTIVATION: exactly one managed type is activated, and it is namespaced.
 *   - DNS_TYPE_FOLLOWS_TARGET: hostnames publish as CNAME; IPv4-only ingress publishes as A.
 *   - DNS_CREATE_AMBIGUITY_RECOVERS_BY_NAME: only provider-confirmed ambiguous DNS creates are
 *     released to the name-addressed OBSERVE path; paid lease creates remain fail-closed.
 *   - OVERLAP_BEFORE_CLOSE: a lease close is IRREVERSIBLE and its idempotence key is refused
 *     forever once settled, so the outgoing lease is held open until the incoming one is proven
 *     serving and DNS has flipped. Never more than two lease children for one (node, env).
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
const specObjectSchema = (
  ((version.schema as YamlObject).openAPIV3Schema as YamlObject)
    .properties as YamlObject
).spec as YamlObject;
const specSchema = specObjectSchema.properties as YamlObject;
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
      // story.5050 — node-owned HARD placement requirement. Optional and immutable, so no
      // existing XR changes and a new requirement can only bind on a fresh mint.
      "placement",
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
      // bug.5287: the deadline binds to the CURRENT attempt via $hasServedDesired.
      // The retired '$neverServed' form keyed on a LATCHED field, so it could only ever be
      // true on a first boot and made BOOT_SLO_OR_CLOSE unreachable thereafter.
      "$deadlineExceeded := and (not $hasServedDesired) (gt $ageSeconds $bootDeadlineSeconds)"
    );
  });

  it("anchors the boot deadline to the current attempt, not the XR's age (bug.5244)", () => {
    // Anchored to creationTimestamp, a never-served XR older than the deadline was a
    // roach motel: $closeForBudget latched true, the lease Request stopped rendering, so
    // no OBSERVE could ever set $prevSha and no spec change could revive the workload.
    // The anchor must be the (bundle sha, leaseGeneration) attempt, latched via status.
    expect(template).toContain(
      '$bootKey := printf "%s:%d" $desiredSha $leaseGeneration'
    );
    expect(template).toContain('dig "status" "bootEpoch" "key" "" $xr');
    // The window resets ONLY when the attempt key changes — a mere re-render of the same
    // attempt must keep the recorded start, or the deadline could never fire at all.
    expect(template).toContain(
      'and (eq $prevBootKey $bootKey) (ne $prevBootAt "")'
    );
    // The latch is persisted where the next render reads it.
    const bootEpoch = (statusSchema.bootEpoch as YamlObject)
      .properties as YamlObject;
    expect(Object.keys(bootEpoch)).toEqual(["key", "at"]);
  });

  it("emits the host-routed serving proof after the phase-1 reader rollout (bug.5237)", () => {
    // A stale deployment still owning the public hostname made the bare-ingress serving
    // probe a lie. The fix is OBSERVE handing the actuator the public hostname — but the
    // actuator's observe schema is a strictObject, so emitting the key before every
    // environment's actuator image accepts it would 400 every observe and freeze
    // reconciliation fleet-wide. Phase 1 deployed that strict-schema reader fleet-wide;
    // phase 2 now emits `publicHost` and must never regress to bare-ingress truth.
    expect(template).toContain("bug.5237 PHASE 2");
    expect(templateCode).toContain("publicHost: {{ $publicHost | quote }}");
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
  it("binds the boot deadline to the current attempt, not to ever-served (bug.5287)", () => {
    // $prevSha is LATCHED, so `eq $prevSha ""` is only ever true on a first boot. Keying the
    // deadline on it made BOOT_SLO_OR_CLOSE unreachable for the rest of an XR's life — toks5
    // production billed three generations with bootDeadlineAt hours past and reason=None.
    expect(templateCode).toContain(
      "$deadlineExceeded := and (not $hasServedDesired) (gt $ageSeconds $bootDeadlineSeconds)"
    );
    // no live template expression may reference the retired predicate
    const live = templateCode
      .split("\n")
      .filter((l) => l.includes("$neverServed") && l.includes("{{-"));
    expect(live).toEqual([]);
  });

  it("never latches a migration failure into a terminal phase (bug.5309)", () => {
    // The DISPLAY latch is correct and must stay: status.migration.phase falls back to the
    // previous phase so it does not blink out on ticks carrying no migration answer.
    expect(templateCode).toContain(
      '$migrationPhase := dig "migration" "phase" $prevMigrationPhase $resp'
    );
    // The TERMINAL decision must read the CURRENT response only. Deciding from the latched
    // $migrationPhase made one transient failure permanent: toks4 candidate-a sat
    // Failed/MigrationFailed with a succeeded Job, a present database and the actuator
    // logging akash_tx_migration_succeeded, and could never recover.
    expect(templateCode).toContain(
      '$migrationFailed := eq (dig "migration" "phase" "" $resp) "failed"'
    );
    expect(templateCode).not.toMatch(
      /\$migrationFailed\s*:=\s*eq\s+\$migrationPhase/
    );
  });

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
    // is `{name, services[], placement?}`. An extra key is a 400 forever, never a
    // partially-honoured call — so the spec dict must be assembled from exactly those keys.
    expect(templateCode).toContain(
      '$specDict := dict "name" $slug "services" $services'
    );
    expect(templateCode).toContain(
      '$payload := dict "cogniKey" $cogniKey "environment" $env "identity" $identity "spec" $specDict'
    );
    // story.5050 is the ONLY conditional key the spec dict may gain. Anything else set on it
    // would reach the strict contract as an unknown field and 400 every create.
    const specDictWrites = [
      ...templateCode.matchAll(/set \$specDict "([a-zA-Z]+)"/g),
    ].map((m) => m[1]);
    expect(specDictWrites).toEqual(["placement"]);
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

  it("keeps the base idempotence key stable and bounds terminal recovery", () => {
    // namespace + name are immutable (name == nodeId). The base varies only with the explicit
    // spec.leaseGeneration; reconcile ticks and metadata generations cannot mint another lease.
    expect(template).toContain(
      '$baseCogniKey := printf "xcw:%s:%s:%d" $ns $name $leaseGeneration'
    );
    // Scoped to the BASE KEY, not the whole template: task.5103 legitimately reads
    // metadata.generation for receipt provenance, but it must never leak into paid identity.
    const keyInputs = ["$ns", "$name", "$leaseGeneration"];
    const keyLiteral =
      /\$baseCogniKey := printf "[^"]*"([^}]*)\}\}/.exec(templateCode)?.[1] ??
      "";
    expect(keyLiteral.trim().split(/\s+/)).toEqual(keyInputs);
    // bug.5287: a settled actor key cannot be re-spent, so Crossplane may advance only through
    // three deterministic children, and only after the response is tied to the CURRENT key and
    // proves it closed. There is no clock/resourceVersion/reconcile-derived namespace.
    expect(templateCode).toContain("$maxRecoveryAttempts := 3");
    expect(templateCode).toContain(
      '$currentKey = printf "%s:recover:%d" $baseCogniKey $recoveryCount'
    );
    expect(templateCode).toContain(
      "$closedForCurrentKey := and $closed (eq $responseKey $currentKey)"
    );
    // An explicit base-generation bump must select a NEW provider-http Request child. Updating
    // the old child invokes UPDATE, which cannot mint the replacement the generation promises.
    // The latch is absent on existing XRs, preserving their static child with zero rollout churn.
    expect(templateCode).toContain(
      '$leaseRequestGeneration := int (dig "status" "leaseRequestGeneration" -1 $xr)'
    );
    expect(templateCode).toContain(
      '$leaseResourceName = printf "akash-lease-g%d" $leaseGeneration'
    );
    expect(templateCode).toContain(
      "gotemplating.fn.crossplane.io/composition-resource-name: {{ $leaseResourceName }}"
    );
    expect(statusSchema.leaseRequestGeneration).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 1000000,
    });
    expect(templateCode).toContain(
      "$recoveryExhausted := and $closedForCurrentKey (ge $recoveryCount $maxRecoveryAttempts)"
    );
    expect(templateCode).toContain(
      "if and $closedForCurrentKey (not $recoveryExhausted)"
    );
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
    ).toBeLessThan(templateCode.indexOf("$baseCogniKey := printf"));
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
      template.indexOf("composition-resource-name: {{ $leaseResourceName }}"),
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
      // bug.5309: the terminal decision reads the CURRENT response, never the latched
      // $migrationPhase — latching it made one transient failure permanent.
      '$migrationFailed := eq (dig "migration" "phase" "" $resp) "failed"'
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
      template.indexOf("composition-resource-name: {{ $leaseResourceName }}"),
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

  it("emits failure unconditionally — 'None' sentinel clears a stale reason (bug.5287)", () => {
    // Omitting the key does not clear it: the status merge preserves the previous value, so
    // a recovered workload kept its stale failure.reason (ledger_unavailable under
    // Progressing) latched for days on four XRs — status lied until someone bumped the
    // generation. The composition therefore ALWAYS writes failure, with "None" as the
    // cleared sentinel; compute-workload-readiness treats "None" as absent (reader
    // tolerance shipped FIRST — akash-actuator-first-rollout).
    expect(template).toContain('reason: "None"');
    // The sentinel must satisfy the XRD reason pattern or the whole status write is rejected.
    expect("None").toMatch(reasonPattern);
  });

  it("reports a settled-key closed lease as LeaseClosed, not a Progressing lie (task.5156)", () => {
    // The render side PARKS a closed lease observed under a non-current key (the Axiom 26 fence
    // above). The status side must tell the same truth. $heldClosed only catches
    // $closedForCurrentKey, so before this branch a closed-under-foreign-key lease with no
    // recovery in flight missed every fail branch and fell through to the default
    // Progressing/reason:"None" — status claimed a permanently-parked lease was still coming up.
    expect(template).toContain("{{- else if $closed }}");
    // Ordered strictly AFTER the active-recovery branch, or it would swallow
    // LeaseRecoveryInProgress and report a recovering lease as terminally closed.
    const chain = template.slice(
      template.lastIndexOf('{{- $phase := "Progressing" }}')
    );
    expect(chain.indexOf("LeaseRecoveryInProgress")).toBeLessThan(
      chain.indexOf("{{- else if $closed }}")
    );
  });

  it("keeps paid replacement OPT-IN and BOUNDED now that Replace is admitted (story.5050)", () => {
    // The second fence has moved, not vanished. This test previously pinned `enum: [Hold]`
    // because provider-strike recording did not yet live in the actuator — without it, a retry
    // re-picked the provider that had just failed. task.5153 re-homed strikes (the actuator emits
    // `akash_tx_provider_strike_recorded`), which is the stated precondition the XRD named, so
    // Replace is admitted. What must NOT weaken:
    //   - Hold stays the DEFAULT, so admitting Replace changes no existing row.
    //   - The composition still gates the recovery-key bump on onGiveUp == Replace.
    //   - The bump stays BOUNDED by $recoveryExhausted; Replace must never mean unbounded spend.
    //   - Hold still parks a closed lease as LeaseClosed with zero spend.
    expect(template).toContain(
      'if and $closedForCurrentKey (not $recoveryExhausted) (eq $onGiveUp "Replace")'
    );
    const onGiveUp = (
      (specSchema.bootPolicy as YamlObject).properties as YamlObject
    ).onGiveUp as YamlObject;
    expect(onGiveUp.enum).toEqual(["Hold", "Replace"]);
    expect(onGiveUp.default).toBe("Hold");
    expect(template).toContain('$failReason = "LeaseClosed"');
    // The retry is only useful because it lands ELSEWHERE — the excluded set is what makes a
    // bounded re-mint progress instead of re-picking the dead provider three times.
    expect(templateCode).toContain("$desiredRecoveryPrefix");
  });

  it("never re-renders a lease Request under a settled key (Axiom 26 fence)", () => {
    // Closed current and foreign keys remain parked exactly as before. A different explicit base
    // generation is handled by selecting a NEW generation-qualified child above this fence.
    expect(template).toContain(
      "$renderLease := not (or $closeForBudget $recoveryExhausted $heldClosed (and $closed (not $closedForCurrentKey)))"
    );
    expect(template).toContain(
      '$heldClosed := and $closedForCurrentKey (ne $onGiveUp "Replace")'
    );
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

  it("publishes a PROXIED address record, because the provider's certificate is not ours", () => {
    // Whether the provider target is a hostname or IPv4 address, a grey-cloud record bypasses
    // Cloudflare's TLS termination for the Cogni hostname.
    expect(dnsBlock).not.toContain("proxied: false");
    // CREATE body + UPDATE body.
    expect(dnsBlock.match(/proxied: true/g)?.length).toBe(2);
    // ...and drift back to grey-cloud is not "up to date".
    expect(dnsBlock).toContain("| .[0].proxied) == true");
  });

  it("uses a hostname CNAME when available and falls back to an IPv4 A record", () => {
    // A provider hostname is more stable than its current ingress IP, so retain the existing
    // preference. RHITE proved that rejecting every IPv4 target leaves a healthy paid lease
    // permanently unreachable, so the first IPv4 is the bounded fallback.
    expect(templateCode).toContain('$dnsHostnameTarget := ""');
    expect(templateCode).toContain('$dnsIpv4Target := ""');
    expect(templateCode).toContain("(ne $h $publicHost)");
    expect(templateCode).toContain("$dnsTarget := $dnsHostnameTarget");
    expect(templateCode).toContain(
      'if eq $dnsTarget "" }}{{ $dnsTarget = $dnsIpv4Target'
    );
    expect(templateCode).toContain('$dnsRecordType := "CNAME"');
    expect(templateCode).toContain('$dnsRecordType = "A"');
  });

  it("carries the target-derived record type through create, update, drift, and status", () => {
    expect(templateCode).toContain(
      '$cfPayload := dict "name" $publicHost "content" $effectiveDnsTarget "type" $dnsRecordType'
    );
    // CREATE and UPDATE consume the same payload type.
    expect(dnsBlock.match(/type: \.payload\.body\.type/g)?.length).toBe(2);
    expect(dnsBlock).toContain(
      "({{ $cfAdoptable }} | .[0].type) == .payload.body.type"
    );
    expect(templateCode).toContain('(eq (dig "type" "" .) $dnsRecordType)');
  });

  it("reports published as an observation, never as an echo of the intent", () => {
    // `published` used to restate that spec.dns was set, so an XR whose Cloudflare write had
    // failed since birth still claimed its hostname was published. The one field an operator
    // reads to answer "is this node reachable by NAME?" must be able to say no.
    expect(templateCode).toContain("published: {{ $dnsPublished }}");
    expect(templateCode).not.toContain("published: {{ if $dns }}");
    expect(templateCode).toContain('index $observedResources "dns-record"');
  });

  it("recovers only provider-confirmed ambiguous DNS creates through name observation", () => {
    expect(templateCode).toContain('$dnsCreatePending := ""');
    expect(templateCode).toContain("$dnsCreateAmbiguous := false");
    expect(templateCode).toContain(
      'get $dnsAnnotations "crossplane.io/external-create-pending"'
    );
    expect(templateCode).toContain(
      'contains "cannot determine creation result"'
    );
    expect(dnsBlock).toContain(
      "crossplane.io/external-create-succeeded: {{ $dnsCreatePending | quote }}"
    );
    expect(dnsBlock).toContain(
      'if and $dnsCreateAmbiguous (ne $dnsCreatePending "")'
    );

    // The paid lease Request must retain Crossplane's leak-prevention refusal. This recovery is
    // safe only because the DNS OBSERVE is name-addressed and adoption precedes CREATE.
    const leaseBlock = templateCode.slice(
      templateCode.indexOf(
        "composition-resource-name: {{ $leaseResourceName }}"
      ),
      templateCode.indexOf("composition-resource-name: dns-record")
    );
    expect(leaseBlock).not.toContain("external-create-succeeded");
  });
});

describe("XComputeWorkload DNS survives a promotion transition (bug.5188)", () => {
  // Everything from the Cloudflare Request to the end of the template, prose-stripped: the
  // assertions here pin the last-known-good DNS latch that keeps a promotion from withdrawing
  // the live public record when the current observe carries an ERROR body with no endpoints.
  const dnsBlock = templateCode.slice(
    templateCode.indexOf("composition-resource-name: dns-record")
  );

  it("latches the last-known-good target from status, exactly like $prevSha/$prevResource", () => {
    // provider-http overwrites status.response.body with the ERROR body of a failed mutation
    // (see the lease-handle latch), which has no endpoints, so $dnsTarget collapses to "" while
    // a promotion's migration runs. The last-served target is read back from status.dns.target
    // and carried forward — the same posture the observed-bundle and lease-handle latches take.
    expect(templateCode).toContain(
      '$prevDnsTarget := dig "status" "dns" "target" ""'
    );
    expect(templateCode).toContain("$effectiveDnsTarget");
  });

  it("gates the composed dns-record child on the LATCHED target, never the collapsing one", () => {
    // The render gate is what a transient endpoint-less observe used to fail: an omitted child
    // is garbage-collected, which fires a real Cloudflare DELETE and takes the live proxied
    // CNAME to NXDOMAIN. The gate must read the latched value so the child keeps rendering.
    expect(templateCode).toContain('if and $dns (ne $effectiveDnsTarget "")');
    expect(templateCode).not.toContain('if and $dns (ne $dnsTarget "")');
  });

  it("never couples DNS publication to lease liveness (bug.5301)", () => {
    // Third instance of this hazard class: an omitted dns-record child is a REAL Cloudflare
    // DELETE. bug.5188 defended the mid-promote collapse with the last-known-good latch, but
    // the gate still shared $renderLease — so every terminal lease condition (budget close,
    // recovery exhaustion, Hold-park, foreign-key closure) took the public hostname to
    // NXDOMAIN (beacon/node-template, 2026-09-28). Once onGiveUp: Replace is armed, closure
    // is ROUTINE and each recovery cycle would open an NXDOMAIN window. The hostname
    // withdraws only on genuine XR deletion via finalization.
    expect(templateCode).not.toMatch(/if and \$dns [^\n]*\$renderLease/);
  });

  it("adopts a genuinely-new target only once the new revision actually serves", () => {
    // PROVE_BEFORE_TRAFFIC: a different, non-empty $dnsTarget is only trusted while the workload
    // is active AND serving. Until then the record keeps pointing at the last-known-good target,
    // so a mid-flight endpoint change can never repoint the live name at a not-yet-serving lease.
    expect(templateCode).toContain(
      '{{- else if and (ne $prevDnsTarget "") (ne $dnsTarget $prevDnsTarget) (not (and $active $serving)) }}'
    );
  });

  it("writes the latched target onto the Cloudflare record content", () => {
    // The record the composite intends to hold must be the latched target, not the collapsed
    // one — otherwise the CREATE/UPDATE body would publish "" the instant the observe errored.
    expect(dnsBlock.length).toBeGreaterThan(0);
    expect(templateCode).toContain(
      '$cfPayload := dict "name" $publicHost "content" $effectiveDnsTarget "type" $dnsRecordType'
    );
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
   * THE VALUE IS THE MONEY (bug.5192). toks5 production and preview each have terminally
   * settled receipts, so their rows MUST stay on explicit replacement generations. A
   * changed suffix answers "no existing resource" and mints a SECOND PAID LEASE, and a suffix
   * that reverted to 0 re-deads the node against a key the actuator already spent.
   */
  it("keeps toks5 environments on their explicit replacement generations when that fleet row exists", () => {
    const toks5Path = path.join(CATALOG_DIR, "toks5.yaml");
    if (!existsSync(toks5Path)) return;

    const toks5 = parse(readFileSync(toks5Path, "utf8")) as {
      lease_generation?: Record<string, number>;
    };
    // story.5047: bumped 1->2 to force a fresh mint delivering DOLTGRES_URL (knowledge heal).
    // bug.5302: bumped 2->3 — the gen-2 lease died in the 2026-09-29 account-depletion
    // event (escrow drained fleet-wide); 3 is the funded replacement mint.
    // bug.5287: bumped 3->4 — the gen-3 lease reached the chain and bills but its workload
    // never came up; the actuator replay path treats that partial receipt as settled and
    // returns the dead handle forever (64x create_replayed, 0 create-family). A fresh key
    // cannot replay, so 4 forces createAndLease. Durable fix: task.5157 (settled/serving gate).
    // bug.5287: bumped 4->5 — gen-4's fresh createAndLease reached allocation_recorded then
    // hit manifest_not_delivered (HTTP 404, deployment closed, escrow refunding, rolled back
    // before akash_tx_leased). Its receipt is stuck allocated+external_name over a verified-
    // closed lease, so a retry under :4 would replay the dead handle (task.5157 case c). toks5's
    // SDL is identical to healthy toks4, so gen-4's 404 reads as transient; 5 is a fresh key
    // that re-enters createAndLease to retry the manifest delivery.
    // task.5180: preview gen-1 reached BootDeadlineClosed after a provider-http UPDATE wedge;
    // its closed lease makes :1 spent, so :2 is the reviewed replacement.
    expect(toks5.lease_generation?.preview).toBe(2);
    expect(toks5.lease_generation?.production).toBe(5);
  });
});

describe("XComputeWorkload placement requirement (story.5050)", () => {
  const placement = specSchema.placement as Record<string, never> &
    Record<string, unknown>;
  const placementRule = (
    (specObjectSchema["x-kubernetes-validations"] ?? []) as {
      rule: string;
      message: string;
    }[]
  ).find((rule) => /placement may change/.test(rule.message));

  /**
   * Truth table for the transition contract expressed by placementRule. Kubernetes is the CEL
   * runtime, so candidate-a remains the executable integration proof; this pins both semantic
   * directions that the old field-scoped presence assertion could not distinguish.
   */
  function allowsPlacementTransition(input: {
    samePlacement: boolean;
    oldGeneration?: number;
    oldEpoch?: number;
    newGeneration?: number;
  }): boolean {
    if (input.samePlacement) return true;
    if (input.newGeneration === undefined) return false;
    return input.newGeneration > (input.oldGeneration ?? input.oldEpoch ?? 0);
  }

  /**
   * Akash refuses in-place placement change, so an accepted edit without a fresh key would be
   * desired state nothing applies — the node keeps serving from its old jurisdiction while the
   * XR claims otherwise. The rule must live at spec scope so it can admit the env-manager's
   * atomic placement + leaseGeneration bump while rejecting a placement-only edit.
   */
  it("allows re-placement only alongside a leaseGeneration bump", () => {
    expect(placementRule?.rule.replace(/\s+/g, " ").trim()).toBe(
      "(!has(self.placement) && !has(oldSelf.placement)) || " +
        "(has(self.placement) && has(oldSelf.placement) && self.placement == oldSelf.placement) || " +
        "(has(self.leaseGeneration) && self.leaseGeneration > " +
        "(has(oldSelf.leaseGeneration) ? oldSelf.leaseGeneration : " +
        "(has(oldSelf.leaseEpoch) ? oldSelf.leaseEpoch : 0)))"
    );
    expect(placement["x-kubernetes-validations"]).toBeUndefined();
  });

  it.each([
    {
      case: "admits present-to-different-present with a generation increase",
      input: { samePlacement: false, oldGeneration: 6, newGeneration: 7 },
      expected: true,
    },
    {
      case: "rejects present-to-different-present without a generation increase",
      input: { samePlacement: false, oldGeneration: 6, newGeneration: 6 },
      expected: false,
    },
    {
      case: "rejects a generation decrease that could replay a spent key",
      input: { samePlacement: false, oldGeneration: 6, newGeneration: 5 },
      expected: false,
    },
    {
      case: "admits an unchanged placement without spending a generation",
      input: { samePlacement: true, oldGeneration: 6, newGeneration: 6 },
      expected: true,
    },
    {
      case: "compares against the legacy epoch while upgrading an older XR",
      input: { samePlacement: false, oldEpoch: 6, newGeneration: 7 },
      expected: true,
    },
  ])("$case", ({ input, expected }) => {
    expect(allowsPlacementTransition(input)).toBe(expected);
  });

  /**
   * EMPTY_IS_A_TYPO_NOT_A_WILDCARD. The actuator fails closed on this field, so an empty list
   * would refuse every bid and present as "no provider bid for this workload" — the most
   * expensive possible way to learn about a typo. The API server must reject it first.
   */
  it("rejects an empty country list rather than accepting a lease-refusing wildcard", () => {
    const countries = (
      placement["properties"] as Record<string, Record<string, unknown>>
    )["requiredCountries"];
    expect(countries["minItems"]).toBe(1);
    expect(countries["x-kubernetes-list-type"]).toBe("set");
    expect((countries["items"] as Record<string, unknown>)["pattern"]).toBe(
      "^[A-Z]{2}$"
    );
  });

  /**
   * The wire is a zod strictObject, so the Composition must lower the XR field onto the
   * contract's own name. A rename drift here is a 400 at create time, not a silently
   * unconstrained lease — but only if the lowering exists at all.
   */
  it("lowers onto the actuator wire under the contract's name", () => {
    expect(templateCode).toContain(
      '$requiredCountries := dig "placement" "requiredCountries" (list) $spec'
    );
    expect(templateCode).toContain(
      'set $specDict "placement" (dict "requiredCountryCodes" $requiredCountries)'
    );
    // Absent must stay ABSENT: an empty list on the wire fails closed in the actuator.
    expect(templateCode).toContain("{{- if gt (len $requiredCountries) 0 }}");
  });
});

/**
 * OVERLAP_BEFORE_CLOSE (bug.5322). Crossplane garbage-collects whatever the render function
 * stops returning, and for a live Akash lease that GC is a REMOVE -> /v1/akash/delete. So
 * advancing the generation-qualified child name on a leaseGeneration bump ALSO closed the
 * incumbent lease before its replacement had served anything (toks4, 2026-09-30: /readyz 503,
 * stale sha, no lease). A close is IRREVERSIBLE and its idempotence key is refused forever once
 * settled, so the ordering must be mint -> prove serving -> flip DNS -> close.
 *
 * The Go render itself cannot run in this suite (function-go-templating is a Go binary), so the
 * behavioural cases below drive a TypeScript MODEL of the three decisions this change touches:
 * which lease children are rendered, which key the retained one carries, and when
 * status.activeLeaseGeneration advances. The model is kept honest by
 * "the model mirrors the template it stands in for" below, which pins every expression it
 * mirrors against the real template source — the same contract `renderCogniKey` and
 * `allowsPlacementTransition` already use in this file.
 */
describe("XComputeWorkload holds the outgoing lease until the replacement serves (bug.5322)", () => {
  type LeaseResponse = {
    found?: boolean;
    serving?: boolean;
    code?: string;
    resource?: {
      state?: string;
      externalName?: string;
      endpoints?: string[];
    };
  };
  type ObservedChild = {
    /** status.requestDetails.body.cogniKey — the key that actually minted this child's lease. */
    requestKey?: string;
    /** status.response.body */
    response?: LeaseResponse;
  };
  type XrState = {
    leaseGeneration: number;
    status: {
      leaseRequestGeneration?: number;
      activeLeaseGeneration?: number;
      dns?: { target?: string };
    };
    observed: Record<string, ObservedChild>;
  };

  const NS = "cogni-production";
  const NAME = "toks4";
  const PUBLIC_HOST = "toks4.cognidao.org";
  const INCUMBENT_TARGET = "provider-blue.akash.example";
  const CANDIDATE_TARGET = "provider-green.akash.example";

  /**
   * Mirrors, in order: GENERATION_BUMP_REPLACES_THE_REQUEST (unchanged by this PR),
   * OVERLAP_BEFORE_CLOSE, the candidate observation, the last-known-good DNS latch, and the
   * status.activeLeaseGeneration write.
   *
   * Scope: assumes $renderLease is true (the terminal fences it is built from — $closeForBudget,
   * $recoveryExhausted, $heldClosed, the settled-key clause — are untouched by this change and
   * are pinned verbatim by "never re-renders a lease Request under a settled key"). The DNS leg
   * models the provider-HOSTNAME branch only; the IPv4/A-record split is pinned by
   * "uses a hostname CNAME when available and falls back to an IPv4 A record".
   */
  function render(xr: XrState) {
    const observed = xr.observed;
    const baseCogniKey = `xcw:${NS}:${NAME}:${xr.leaseGeneration}`;

    // ---- GENERATION_BUMP_REPLACES_THE_REQUEST (pre-existing, unchanged)
    let leaseRequestGeneration = xr.status.leaseRequestGeneration ?? -1;
    let leaseResourceName =
      leaseRequestGeneration >= 0
        ? `akash-lease-g${leaseRequestGeneration}`
        : "akash-lease";
    const initialResponseKey = observed[leaseResourceName]?.requestKey ?? "";
    const initialMatchesDesired =
      initialResponseKey === baseCogniKey ||
      initialResponseKey.startsWith(`${baseCogniKey}:recover:`);
    if (
      (leaseRequestGeneration >= 0 &&
        leaseRequestGeneration !== xr.leaseGeneration) ||
      (leaseRequestGeneration < 0 &&
        initialResponseKey !== "" &&
        !initialMatchesDesired)
    ) {
      leaseRequestGeneration = xr.leaseGeneration;
      leaseResourceName = `akash-lease-g${xr.leaseGeneration}`;
    }

    // ---- OVERLAP_BEFORE_CLOSE (bug.5322)
    const activeLeaseGeneration = xr.status.activeLeaseGeneration ?? -1;
    let retainedResourceName = "";
    let retainedKey = "";
    let retainedResp: LeaseResponse = {};
    if (
      activeLeaseGeneration >= 0 &&
      activeLeaseGeneration !== xr.leaseGeneration
    ) {
      const activeBaseKey = `xcw:${NS}:${NAME}:${activeLeaseGeneration}`;
      const activeRecoveryPrefix = `${activeBaseKey}:recover:`;
      // `range` over a Go map walks the keys in sorted order; first match wins.
      for (const childName of Object.keys(observed).sort()) {
        if (
          retainedResourceName !== "" ||
          !childName.startsWith("akash-lease") ||
          childName === leaseResourceName
        ) {
          continue;
        }
        const childKey = observed[childName].requestKey ?? "";
        if (
          childKey === activeBaseKey ||
          (childKey !== "" && childKey.startsWith(activeRecoveryPrefix))
        ) {
          retainedResourceName = childName;
          retainedKey = childKey;
          retainedResp = observed[childName].response ?? {};
        }
      }
    }
    const retainedRes = retainedResp.resource ?? {};
    const retainedState = retainedRes.state ?? "unknown";
    const retainedFound =
      retainedResp.found ?? (retainedRes.externalName ?? "") !== "";
    const retainedObserved = Object.hasOwn(retainedResp, "found");
    const retainedGone =
      retainedObserved && (!retainedFound || retainedState === "closed");
    const holdOutgoingLease = retainedResourceName !== "" && !retainedGone;

    // ---- the CANDIDATE child's observation (what $active/$serving read)
    const resp = observed[leaseResourceName]?.response ?? {};
    const res = resp.resource ?? {};
    const state = res.state ?? "unknown";
    const externalName = res.externalName ?? "";
    const found = resp.found ?? externalName !== "";
    const serving = resp.serving ?? false;
    const active = found && state === "active";

    // ---- DNS target + LAST-KNOWN-GOOD latch (bug.5188, unchanged)
    let dnsTarget = "";
    for (const endpoint of res.endpoints ?? []) {
      const host = endpoint
        .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "")
        .split("/")[0]
        .split(":")[0]
        .toLowerCase()
        .replace(/\.$/, "");
      if (host !== "" && host !== PUBLIC_HOST && dnsTarget === "") {
        dnsTarget = host;
      }
    }
    const prevDnsTarget = xr.status.dns?.target ?? "";
    let effectiveDnsTarget = dnsTarget;
    if (dnsTarget === "") {
      effectiveDnsTarget = prevDnsTarget;
    } else if (
      prevDnsTarget !== "" &&
      dnsTarget !== prevDnsTarget &&
      !(active && serving)
    ) {
      effectiveDnsTarget = prevDnsTarget;
    }

    return {
      /** Every composed LEASE child this render returns, sorted. */
      leaseChildren: (holdOutgoingLease
        ? [retainedResourceName, leaseResourceName]
        : [leaseResourceName]
      ).sort(),
      candidateChild: leaseResourceName,
      retainedCogniKey: holdOutgoingLease ? retainedKey : undefined,
      effectiveDnsTarget,
      status: {
        leaseRequestGeneration,
        activeLeaseGeneration:
          active && serving
            ? xr.leaseGeneration
            : activeLeaseGeneration >= 0
              ? activeLeaseGeneration
              : undefined,
      },
    };
  }

  /** A live lease that answers OBSERVE as active and serving its exact sha. */
  const servingOn = (
    externalName: string,
    target: string
  ): ObservedChild["response"] => ({
    found: true,
    serving: true,
    resource: {
      state: "active",
      externalName,
      endpoints: [`http://${target}:32001`],
    },
  });

  it("declares the proven-serving generation in status, bounded like its neighbours", () => {
    expect(statusSchema.activeLeaseGeneration).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 1000000,
    });
    // The field is the cutover latch; the API must say what writes it and why, or the next
    // reader re-derives "bump the generation and let GC sort it out" — which is the bug.
    const raw = readFileSync(path.join(DIR, "xrd.yaml"), "utf8");
    const doc = raw.slice(
      raw.indexOf("# THE GENERATION PROVEN SERVING (bug.5322)"),
      raw.indexOf("activeLeaseGeneration:")
    );
    expect(doc).toContain("active && serving");
    expect(doc).toContain("CLOSE-AFTER-CUTOVER");
  });

  it("the model mirrors the template it stands in for", () => {
    // Every expression the model above reproduces, pinned against the real source. If the
    // template changes shape, this fails and the behavioural cases below stop being evidence.
    for (const expression of [
      '$activeLeaseGeneration := int (dig "status" "activeLeaseGeneration" -1 $xr)',
      "if and (ge $activeLeaseGeneration 0) (ne $activeLeaseGeneration $leaseGeneration)",
      '$activeBaseKey := printf "xcw:%s:%s:%d" $ns $name $activeLeaseGeneration',
      '$activeRecoveryPrefix := printf "%s:recover:" $activeBaseKey',
      "range $childName, $child := $observedResources",
      'if and (eq $retainedResourceName "") (hasPrefix "akash-lease" $childName) (ne $childName $leaseResourceName)',
      '$childBodyRaw := dig "status" "requestDetails" "body" "" $child.resource',
      'if ne $childBodyRaw "" }}{{ $childKey = dig "cogniKey" "" (fromJson $childBodyRaw) }}',
      'if or (eq $childKey $activeBaseKey) (and (ne $childKey "") (hasPrefix $activeRecoveryPrefix $childKey))',
      "$retainedResourceName = $childName",
      "$retainedKey = $childKey",
      '$retainedState := dig "state" "unknown" $retainedRes',
      '$retainedFound := dig "found" (ne (dig "externalName" "" $retainedRes) "") $retainedResp',
      '$retainedObserved := hasKey $retainedResp "found"',
      '$retainedGone := and $retainedObserved (or (not $retainedFound) (eq $retainedState "closed"))',
      '$holdOutgoingLease := and (ne $retainedResourceName "") (not $retainedGone)',
      "{{- if and $active $serving }}",
      "activeLeaseGeneration: {{ $leaseGeneration }}",
      "{{- else if ge $activeLeaseGeneration 0 }}",
      "activeLeaseGeneration: {{ $activeLeaseGeneration }}",
    ]) {
      expect(templateCode, expression).toContain(expression);
    }
  });

  it("renders byte-identically in steady state — one lease child, no retention", () => {
    // active == desired, so the whole block is inert: there is nothing to hold and nothing to
    // cut over to. This is every healthy workload in the fleet on every reconcile tick.
    const out = render({
      leaseGeneration: 7,
      status: {
        leaseRequestGeneration: 7,
        activeLeaseGeneration: 7,
        dns: { target: INCUMBENT_TARGET },
      },
      observed: {
        "akash-lease-g7": {
          requestKey: `xcw:${NS}:${NAME}:7`,
          response: servingOn("lease-7", INCUMBENT_TARGET),
        },
      },
    });
    expect(out.leaseChildren).toEqual(["akash-lease-g7"]);
    expect(out.retainedCogniKey).toBeUndefined();
    expect(out.effectiveDnsTarget).toBe(INCUMBENT_TARGET);
    // Idempotent: a serving steady state keeps re-asserting the same generation.
    expect(out.status.activeLeaseGeneration).toBe(7);
  });

  it("renders byte-identically for a fleet XR that has no activeLeaseGeneration yet", () => {
    // EVERY XR in the fleet omits the field today. Absent digs to -1, which disables retention
    // entirely — so rolling this composition out changes no render anywhere until a workload is
    // next observed serving. The bump below therefore still behaves exactly as main does.
    const bumped = render({
      leaseGeneration: 1,
      status: { dns: { target: INCUMBENT_TARGET } },
      observed: {
        "akash-lease": {
          requestKey: `xcw:${NS}:${NAME}:0`,
          response: servingOn("lease-0", INCUMBENT_TARGET),
        },
      },
    });
    expect(bumped.leaseChildren).toEqual(["akash-lease-g1"]);
    expect(bumped.retainedCogniKey).toBeUndefined();
    expect(bumped.status.activeLeaseGeneration).toBeUndefined();

    // ADOPTION, with zero churn: the first tick that observes the workload serving writes the
    // field, and from then on its next bump is protected.
    const adopting = render({
      leaseGeneration: 0,
      status: { dns: { target: INCUMBENT_TARGET } },
      observed: {
        "akash-lease": {
          requestKey: `xcw:${NS}:${NAME}:0`,
          response: servingOn("lease-0", INCUMBENT_TARGET),
        },
      },
    });
    expect(adopting.leaseChildren).toEqual(["akash-lease"]);
    expect(adopting.status.activeLeaseGeneration).toBe(0);
  });

  it("holds the live serving incumbent alongside the candidate, DNS unmoved", () => {
    // THE bug. Before this change the g7 child stopped being rendered the instant the bump
    // landed, Crossplane GC'd it, provider-http issued REMOVE, and the actuator closed a lease
    // that was still the only thing answering on the public hostname.
    const out = render({
      leaseGeneration: 8,
      status: {
        leaseRequestGeneration: 7,
        activeLeaseGeneration: 7,
        dns: { target: INCUMBENT_TARGET },
      },
      observed: {
        "akash-lease-g7": {
          requestKey: `xcw:${NS}:${NAME}:7`,
          response: servingOn("lease-7", INCUMBENT_TARGET),
        },
        "akash-lease-g8": {
          requestKey: `xcw:${NS}:${NAME}:8`,
          response: {
            found: true,
            serving: false,
            resource: {
              state: "active",
              externalName: "lease-8",
              endpoints: [`http://${CANDIDATE_TARGET}:32001`],
            },
          },
        },
      },
    });
    expect(out.leaseChildren).toEqual(["akash-lease-g7", "akash-lease-g8"]);
    expect(out.candidateChild).toBe("akash-lease-g8");
    // The retained child must close under the key that MINTED it, read back from its own
    // request body. A reconstructed key would hand REMOVE something the actuator never
    // allocated and leave a live lease billing forever.
    expect(out.retainedCogniKey).toBe(`xcw:${NS}:${NAME}:7`);
    // PROVE_BEFORE_TRAFFIC: the candidate is leased and has endpoints, but is not serving, so
    // the public name stays on the incumbent.
    expect(out.effectiveDnsTarget).toBe(INCUMBENT_TARGET);
    expect(out.status.activeLeaseGeneration).toBe(7);
  });

  it("retains a lease minted under a bounded recovery key under THAT key", () => {
    // bug.5287's `:recover:<n>` children are real minted leases. Closing one requires its own
    // key, which is exactly why the retained key is read back rather than rebuilt from
    // $activeLeaseGeneration.
    const out = render({
      leaseGeneration: 8,
      status: { leaseRequestGeneration: 7, activeLeaseGeneration: 7 },
      observed: {
        "akash-lease-g7": {
          requestKey: `xcw:${NS}:${NAME}:7:recover:2`,
          response: servingOn("lease-7r2", INCUMBENT_TARGET),
        },
      },
    });
    expect(out.leaseChildren).toEqual(["akash-lease-g7", "akash-lease-g8"]);
    expect(out.retainedCogniKey).toBe(`xcw:${NS}:${NAME}:7:recover:2`);
  });

  it("retains NOTHING when the outgoing lease is already closed", () => {
    // The ordinary replace-a-terminally-spent-lease flow (PR #2582 replaced a spent toks5
    // preview lease). There is no live lease to protect, so the render must be exactly what it
    // is on main: the candidate alone. Regressing this would double-bill every recovery.
    const out = render({
      leaseGeneration: 8,
      status: {
        leaseRequestGeneration: 7,
        activeLeaseGeneration: 7,
        dns: { target: INCUMBENT_TARGET },
      },
      observed: {
        "akash-lease-g7": {
          requestKey: `xcw:${NS}:${NAME}:7`,
          response: {
            found: true,
            resource: { state: "closed", externalName: "lease-7" },
          },
        },
      },
    });
    expect(out.leaseChildren).toEqual(["akash-lease-g8"]);
    expect(out.retainedCogniKey).toBeUndefined();
  });

  it("keeps retaining through a refusal body that carries no observation", () => {
    // provider-http overwrites status.response.body with the ERROR body of a failed mutation —
    // the fact bug.5188's DNS latch exists for. That body has no `found`, so reading "not
    // observed found" as "nothing to protect" would close the LIVE incumbent on a transient
    // refusal. Retention ends only on a POSITIVE closed observation.
    const out = render({
      leaseGeneration: 8,
      status: { leaseRequestGeneration: 7, activeLeaseGeneration: 7 },
      observed: {
        "akash-lease-g7": {
          requestKey: `xcw:${NS}:${NAME}:7`,
          response: { code: "ledger_unavailable" },
        },
      },
    });
    expect(out.leaseChildren).toEqual(["akash-lease-g7", "akash-lease-g8"]);
  });

  it("stops retaining on a POSITIVE found:false, so no settled key is re-rendered", () => {
    // The other direction of the same fence. An OBSERVE that answers `found: false` is read by
    // isRemovedCheck as "the external resource does not exist", so continuing to render that
    // child would fire CREATE under an already-settled key on every reconcile forever — the
    // Axiom 26 churn $renderLease exists to prevent. The presence of the `found` KEY is what
    // separates this from the refusal body above, which carries no observation at all.
    const out = render({
      leaseGeneration: 8,
      status: { leaseRequestGeneration: 7, activeLeaseGeneration: 7 },
      observed: {
        "akash-lease-g7": {
          requestKey: `xcw:${NS}:${NAME}:7`,
          response: { found: false },
        },
      },
    });
    expect(out.leaseChildren).toEqual(["akash-lease-g8"]);
    expect(out.retainedCogniKey).toBeUndefined();
  });

  it("does not advance the latch while the candidate is not serving", () => {
    // A leased-but-not-serving candidate is the toks5 shape: on the chain, billing, nothing
    // answering. It must never be mistaken for a cutover.
    for (const candidate of [
      undefined,
      { found: false },
      { found: true, serving: false, resource: { state: "pending" } },
      {
        found: true,
        serving: false,
        resource: {
          state: "active",
          externalName: "lease-8",
          endpoints: [`http://${CANDIDATE_TARGET}:32001`],
        },
      },
    ] as (LeaseResponse | undefined)[]) {
      const out = render({
        leaseGeneration: 8,
        status: {
          leaseRequestGeneration: 7,
          activeLeaseGeneration: 7,
          dns: { target: INCUMBENT_TARGET },
        },
        observed: {
          "akash-lease-g7": {
            requestKey: `xcw:${NS}:${NAME}:7`,
            response: servingOn("lease-7", INCUMBENT_TARGET),
          },
          "akash-lease-g8": {
            requestKey: `xcw:${NS}:${NAME}:8`,
            response: candidate,
          },
        },
      });
      expect(out.status.activeLeaseGeneration).toBe(7);
      expect(out.leaseChildren).toEqual(["akash-lease-g7", "akash-lease-g8"]);
      expect(out.effectiveDnsTarget).toBe(INCUMBENT_TARGET);
    }
  });

  it("flips DNS and advances the latch once the candidate serves, then closes the old lease", () => {
    // TICK 1 — the candidate is active AND serving its exact sha (the same pair status.serving
    // and the Ready phase are written from). DNS flips; the latch advances. The incumbent is
    // STILL rendered on this tick, so nothing closes before the cutover is recorded.
    const cutover = render({
      leaseGeneration: 8,
      status: {
        leaseRequestGeneration: 7,
        activeLeaseGeneration: 7,
        dns: { target: INCUMBENT_TARGET },
      },
      observed: {
        "akash-lease-g7": {
          requestKey: `xcw:${NS}:${NAME}:7`,
          response: servingOn("lease-7", INCUMBENT_TARGET),
        },
        "akash-lease-g8": {
          requestKey: `xcw:${NS}:${NAME}:8`,
          response: servingOn("lease-8", CANDIDATE_TARGET),
        },
      },
    });
    expect(cutover.effectiveDnsTarget).toBe(CANDIDATE_TARGET);
    expect(cutover.status.activeLeaseGeneration).toBe(8);
    expect(cutover.leaseChildren).toEqual(["akash-lease-g7", "akash-lease-g8"]);

    // TICK 2 — the latch written by tick 1 is read back: active == desired, so the incumbent is
    // no longer rendered. THAT is the close: Crossplane GCs the child and provider-http's
    // REMOVE closes the old lease exactly once, AFTER the replacement served and DNS moved.
    // No new delete call exists anywhere in this change.
    const afterCutover = render({
      leaseGeneration: 8,
      status: {
        leaseRequestGeneration: 8,
        activeLeaseGeneration: cutover.status.activeLeaseGeneration,
        dns: { target: cutover.effectiveDnsTarget },
      },
      observed: {
        "akash-lease-g7": {
          requestKey: `xcw:${NS}:${NAME}:7`,
          response: servingOn("lease-7", INCUMBENT_TARGET),
        },
        "akash-lease-g8": {
          requestKey: `xcw:${NS}:${NAME}:8`,
          response: servingOn("lease-8", CANDIDATE_TARGET),
        },
      },
    });
    expect(afterCutover.leaseChildren).toEqual(["akash-lease-g8"]);
    expect(afterCutover.effectiveDnsTarget).toBe(CANDIDATE_TARGET);
  });

  it("never renders a third lease child, whatever the observed history", () => {
    // AT MOST TWO leases for one (node, env). A second bump during an overlap must still find
    // the PROVEN-SERVING child — not the never-served candidate the first bump left behind —
    // and must not resurrect the stale one as a third.
    const doubleBump = render({
      leaseGeneration: 9,
      status: {
        leaseRequestGeneration: 8,
        activeLeaseGeneration: 7,
        dns: { target: INCUMBENT_TARGET },
      },
      observed: {
        "akash-lease-g6": {
          requestKey: `xcw:${NS}:${NAME}:6`,
          response: {
            found: true,
            resource: { state: "closed", externalName: "lease-6" },
          },
        },
        "akash-lease-g7": {
          requestKey: `xcw:${NS}:${NAME}:7`,
          response: servingOn("lease-7", INCUMBENT_TARGET),
        },
        "akash-lease-g8": {
          requestKey: `xcw:${NS}:${NAME}:8`,
          response: { found: true, resource: { state: "pending" } },
        },
      },
    });
    expect(doubleBump.leaseChildren).toEqual([
      "akash-lease-g7",
      "akash-lease-g9",
    ]);
    expect(doubleBump.retainedCogniKey).toBe(`xcw:${NS}:${NAME}:7`);

    // Exhaustive sweep: every combination of observed children and candidate states still
    // renders at most two lease children, and never the same name twice.
    const states: (LeaseResponse | undefined)[] = [
      undefined,
      { found: false },
      { found: true, resource: { state: "pending" } },
      { found: true, resource: { state: "closed", externalName: "x" } },
      servingOn("x", INCUMBENT_TARGET),
    ];
    for (const activeLeaseGeneration of [undefined, 6, 7, 8]) {
      for (const sevenState of states) {
        for (const eightState of states) {
          const out = render({
            leaseGeneration: 8,
            status: { leaseRequestGeneration: 7, activeLeaseGeneration },
            observed: {
              "akash-lease": {
                requestKey: `xcw:${NS}:${NAME}:0`,
                response: servingOn("lease-0", INCUMBENT_TARGET),
              },
              "akash-lease-g7": {
                requestKey: `xcw:${NS}:${NAME}:7`,
                response: sevenState,
              },
              "akash-lease-g8": {
                requestKey: `xcw:${NS}:${NAME}:8`,
                response: eightState,
              },
            },
          });
          expect(out.leaseChildren.length).toBeLessThanOrEqual(2);
          expect(new Set(out.leaseChildren).size).toBe(
            out.leaseChildren.length
          );
          expect(out.leaseChildren).toContain(out.candidateChild);
        }
      }
    }
  });

  it("holds the incumbent even when the candidate's own Request is fenced off", () => {
    // $renderLease parks a candidate whose key settled closed (Axiom 26). Before this change
    // that left NO lease child at all once the bump had already GC'd the incumbent. Retention
    // is independent of the candidate's fate, so the node keeps serving while the XR reports
    // the terminal truth about the candidate.
    const out = render({
      leaseGeneration: 8,
      status: { leaseRequestGeneration: 7, activeLeaseGeneration: 7 },
      observed: {
        "akash-lease-g7": {
          requestKey: `xcw:${NS}:${NAME}:7`,
          response: servingOn("lease-7", INCUMBENT_TARGET),
        },
      },
    });
    expect(out.leaseChildren).toContain("akash-lease-g7");
    expect(out.retainedCogniKey).toBe(`xcw:${NS}:${NAME}:7`);
  });

  /**
   * The retained Request is a DELIBERATE COPY of the paid lease Request. A copy that drifts is
   * worse than no copy: REMOVE is how the retained child eventually closes its lease, so it has
   * to keep speaking the same actuator wire as the child that minted it.
   */
  describe("the retained Request is the paid Request, modulo four documented differences", () => {
    const COMMENT = /\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g;
    const retainedBlock = template.slice(
      template.lastIndexOf("{{- if $holdOutgoingLease }}"),
      template.indexOf(
        "{{- /* ---------- composed: the paid Akash lease ---------- */ -}}"
      )
    );
    const candidateBlock = template.slice(
      template.indexOf("{{- if $renderLease }}"),
      template.indexOf(
        "{{- /* ---------- composed: DNS intent ---------- */ -}}"
      )
    );

    /**
     * Drops prose, YAML comments, whole-line template actions (the render guards) and the four
     * known differences, then substitutes the retained variable names back to the originals.
     */
    function normalized(block: string): string[] {
      return block
        .replace(COMMENT, "")
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => {
          const t = line.trim();
          return (
            t !== "" &&
            t !== "---" &&
            !t.startsWith("#") &&
            !/^\{\{-?[^{}]*\}\}$/.test(t) &&
            !t.startsWith(
              "gotemplating.fn.crossplane.io/composition-resource-name:"
            ) &&
            !t.startsWith("gotemplating.fn.crossplane.io/ready:")
          );
        })
        .map((line) =>
          line
            .replace("$retainedPayload", "$payload")
            .replace("$retainedUpToDateLogic", "$upToDateLogic")
        );
    }

    it("has both blocks", () => {
      expect(retainedBlock).toContain("kind: Request");
      expect(candidateBlock).toContain("kind: Request");
      // Guard against the comparison below passing on two empty lists if a marker moves.
      expect(normalized(retainedBlock).length).toBeGreaterThan(40);
    });

    it("differs nowhere else — same baseUrl, auth, mappings and isRemovedCheck", () => {
      expect(normalized(retainedBlock)).toEqual(normalized(candidateBlock));
      // The four differences, asserted positively so a future edit cannot quietly merge them.
      expect(retainedBlock).toContain(
        "composition-resource-name: {{ $retainedResourceName }}"
      );
      expect(candidateBlock).toContain(
        "composition-resource-name: {{ $leaseResourceName }}"
      );
      expect(retainedBlock).toContain("body: {{ toJson $retainedPayload");
      expect(retainedBlock).toContain("logic: {{ $retainedUpToDateLogic");
      // The incumbent is never marked ready by the composite: auto-ready reads the Request's
      // own condition, and only the CANDIDATE's serving proof may claim the XR is Ready.
      expect(candidateBlock).toContain("gotemplating.fn.crossplane.io/ready");
      expect(retainedBlock).not.toContain(
        "gotemplating.fn.crossplane.io/ready"
      );
    });

    it("is OBSERVE-only: expectedResponseCheck can never choose UPDATE on a live lease", () => {
      // expectedResponseCheck is the ONLY thing that triggers UPDATE, and an UPDATE here is an
      // in-place SDL replacement — it would restart the incumbent on the CANDIDATE's image.
      // The logic is satisfied by every response under which the child is retained (`active`,
      // or an error body whose .resource.state is null); the one response that falsifies it is
      // the positive `closed` that also stops the child rendering.
      expect(templateCode).toContain(
        '$retainedUpToDateLogic := "(.response.body.resource.state != \\"closed\\")"'
      );
      // It must NOT inherit the convergence clause: `serving` is probed against the CANDIDATE's
      // sha, which a healthy incumbent can never satisfy, so the armed logic would mean an SDL
      // UPDATE on the live lease on every single poll.
      expect(retainedBlock).not.toContain("$upToDateLogic");
      expect(retainedBlock).not.toContain(".response.body.serving == true");
      // CLOSED_IS_REMOVED is preserved verbatim: it is what makes the eventual GC actually
      // close the lease instead of leaving an undeletable Request.
      expect(retainedBlock).toContain(
        '(.response.body.found == false) or (.response.body.resource.state == "closed")'
      );
      // The paid lease's leak-prevention refusal is not relaxed for the retained child either.
      expect(retainedBlock).not.toContain("external-create-succeeded");
    });

    it("introduces no new close or delete path", () => {
      // The close is Crossplane's ordinary GC of a child this function stops returning. Exactly
      // two REMOVE mappings exist in the whole template — one per lease Request — and the only
      // delete route is the actuator's own.
      expect(templateCode.match(/\/v1\/akash\/delete/g)?.length).toBe(2);
      expect(templateCode.match(/action: REMOVE/g)?.length).toBe(3); // 2 lease + 1 DNS
    });
  });

  it("weakens none of the fences it rides on", () => {
    // Everything bug.5322 is built on top of must survive unchanged. These are restatements of
    // assertions elsewhere in this file, gathered here because this change is the one most
    // likely to be tempted into relaxing them.
    expect(template).toContain(
      "$renderLease := not (or $closeForBudget $recoveryExhausted $heldClosed (and $closed (not $closedForCurrentKey)))"
    );
    expect(templateCode).toContain("$maxRecoveryAttempts := 3");
    expect(templateCode).toContain(
      "$recoveryExhausted := and $closedForCurrentKey (ge $recoveryCount $maxRecoveryAttempts)"
    );
    expect(templateCode).toContain(
      '$closeForBudget := and $deadlineExceeded (eq $onDeadline "Close")'
    );
    expect(templateCode).toContain(
      '$heldClosed := and $closedForCurrentKey (ne $onGiveUp "Replace")'
    );
    // The DNS latch still refuses to flip until the CANDIDATE is active AND serving, and
    // $active/$serving are still read from the candidate child alone.
    expect(templateCode).toContain(
      '{{- else if and (ne $prevDnsTarget "") (ne $dnsTarget $prevDnsTarget) (not (and $active $serving)) }}'
    );
    expect(templateCode).toContain(
      "$leaseObs := index $observedResources $leaseResourceName"
    );
    expect(templateCode).toContain(
      '$active := and $found (eq $state "active")'
    );
    // The host-routed serving proof is untouched: it connects to the lease's OWN endpoint while
    // presenting the public host, which is exactly why a candidate can be proven serving BEFORE
    // DNS points at it. A DNS-resolved probe would deadlock this whole design.
    expect(templateCode).toContain("publicHost: {{ $publicHost | quote }}");
  });
});
