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

import { readFileSync } from "node:fs";
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
      "bootPolicy",
      "bundle",
      "dns",
      "environment",
      "leaseEpoch",
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

  it("carries empty-birth migration ordering as declared desired state", () => {
    const policy = (
      (specSchema.migration as YamlObject).properties as YamlObject
    ).policy as YamlObject;
    expect(policy.enum).toEqual(["RequireBeforeTransaction", "Skip"]);
    expect(policy.default).toBe("RequireBeforeTransaction");
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
      '$payload := dict "cogniKey" $cogniKey "environment" $env "spec" (dict "name" $slug "services" $services) "migration" $migration'
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
    // spec.leaseEpoch, which nothing bumps implicitly — a key that changed per generation
    // would report "no existing resource" after a promote and mint a SECOND PAID LEASE.
    expect(template).toContain(
      '$cogniKey := printf "xcw:%s:%s:%d" $ns $name $epoch'
    );
    expect(templateCode).not.toContain("metadata.generation");
    expect(templateCode).not.toContain("resourceVersion");
    const epoch = specSchema.leaseEpoch as YamlObject;
    expect(epoch.default).toBe(0);
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

describe("XComputeWorkload migration precondition (bug.5116 order, bug.5140 gate)", () => {
  it("states its precondition on every mutation, and only on mutations", () => {
    // AkashTxCreateInputSchema and AkashTxUpdateInputSchema BOTH require `migration`. An update
    // mints no lease, but it is still the call that puts a new bundle digest in front of the
    // node's database — which is exactly what bug.5116 ordered.
    expect(template).toContain('"migration" $migration');
    // Scope to the LEASE request: the composition also renders a Cloudflare Request whose
    // mappings share the same action names, and a regex over the whole template would silently
    // assert against DNS instead of the thing that spends money.
    const leaseBlock = template.slice(
      template.indexOf("composition-resource-name: akash-lease"),
      template.indexOf("composition-resource-name: dns-record")
    );
    expect(leaseBlock.length).toBeGreaterThan(0);
    const mappings = Object.fromEntries(
      [
        ...leaseBlock.matchAll(
          /- action: (\w+)\n([\s\S]*?)(?=\n\s+- action: |\n\s+expectedResponseCheck:)/g
        ),
      ].map((m) => [m[1], m[2]])
    );
    expect(Object.keys(mappings).sort()).toEqual([
      "CREATE",
      "OBSERVE",
      "REMOVE",
      "UPDATE",
    ]);
    // CREATE posts the payload verbatim; UPDATE is hand-built and must carry it explicitly.
    expect(mappings.CREATE).toContain(".payload.body");
    expect(mappings.UPDATE).toContain("migration: .payload.body.migration");
    // Observe and delete are strict objects with NO migration field — sending one is a 400.
    expect(mappings.OBSERVE).not.toContain("migration");
    expect(mappings.REMOVE).not.toContain("migration");
  });

  it("builds both branches of the discriminated union, and nothing in between", () => {
    // `Skip` is the DEFAULT accumulator, so the only way to reach the expensive branch is to
    // satisfy its condition — a template bug fails toward the gate, never past it.
    expect(template).toContain('{{- $migration := dict "policy" "Skip" }}');
    // Reached when the workload declares Skip, OR has no cogni-node-app-v1 service (no app
    // image accumulated) and therefore no database.
    expect(template).toContain(
      '{{- if and (eq $migrationPolicy "RequireBeforeTransaction") (ne $appImage "") }}'
    );
    // RequireBeforeTransaction structurally cannot travel without the facts that prove it.
    expect(template).toContain(
      '$migration = dict "policy" "RequireBeforeTransaction" "profile" "cogni-node-app-v1" "bundleDigest" $bundleDigest "image" $appImage "doltgres" $appDoltgres'
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
    // A ref with no digest fails the render rather than sending a request the gate will 400.
    expect(template).toContain(
      "has no sha256 digest to prove a migration against"
    );
  });

  it("never puts a migration command on the wire", () => {
    // `profile` NAMES a command set the actuator owns. A caller-supplied command would let any
    // caller "prove" a migration with a no-op, which makes an enforcing gate advisory.
    const unionLiterals = [
      ...templateCode.matchAll(/\$migration\s*(?::?=)\s*dict ([^}]*)/g),
    ].map((m) => m[1]);
    expect(unionLiterals.length).toBe(2);
    for (const literal of unionLiterals) {
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
    expect(template).toContain(
      '$phase = ternary "Progressing" "Failed" $refusalRetryable'
    );
    // Every code the actuator can emit must satisfy the XRD's reason pattern, or the status
    // write is rejected and the refusal is invisible again.
    for (const code of [
      "migration_pending",
      "migration_failed",
      "migration_unavailable",
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
