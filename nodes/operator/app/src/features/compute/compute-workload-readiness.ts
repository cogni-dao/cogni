// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

type JsonRecord = Readonly<Record<string, unknown>>;

export type ComputeWorkloadReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: string };

/**
 * Project a bundle onto the fields `XComputeWorkload.status.observedBundle` can actually hold.
 *
 * The XRD declares that status field as EXACTLY `{ref, source}` — it structurally cannot carry
 * `spec.bundle.artifacts`. Deep-comparing the two whole objects therefore reported
 * `bundle_not_observed` FOREVER for every node whose bundle lists artifacts, so verify-deploy
 * could never go green no matter how correct the deploy was: poly production sat red while
 * observed and expected named the SAME sha (`51bd530c`), which is what exposed this (bug.5262).
 *
 * `ref` (the immutable bundle digest) plus `source` (repository + revision) fully identify the
 * deployed revision; `artifacts` is derived detail the status contract deliberately omits.
 *
 * The LEGACY ComputeWorkload CRD declares `artifacts` on BOTH spec.bundle and
 * status.observedBundle, so its comparison is already correct and is deliberately left whole.
 */
function observedBundleView(bundle: unknown): unknown {
  const record = asRecord(bundle);
  if (!record) return bundle;
  return { ref: record.ref, source: record.source };
}

/**
 * Name the two SHAs a bundle mismatch is actually about.
 *
 * Bare `bundle_not_observed` cannot distinguish "the actuator has not caught up yet"
 * (wait) from "the cluster XR was never updated to want this bundle at all" (a wedged
 * promote no amount of waiting fixes). Both sides are already in hand at the comparison,
 * and telling them apart otherwise needs cluster access the promote gate does not have —
 * which is why poly production sat for a week with `observedBundle` naming the SHA it was
 * already serving (bug.5262). Same intent as the `phase_not_ready:<failureReason>` suffix
 * below: a promote-gate timeout must name the actual blocker.
 */
function bundleMismatchReason(observed: unknown, expected: unknown): string {
  const sha = (bundle: unknown): string => {
    const value = asRecord(asRecord(bundle)?.source)?.sha;
    return typeof value === "string" && value.length > 0
      ? value.slice(0, 8)
      : "none";
  };
  return `bundle_not_observed:observed=${sha(observed)}:expected=${sha(expected)}`;
}

/**
 * Not-Ready reason for both authority kinds, surfacing the controller's failure
 * reason (e.g. MigrationFailed) so a promote-gate timeout names the actual blocker
 * instead of a generic phase. "None" is the composition's cleared-failure sentinel
 * (bug.5287): `status.failure` is emitted UNCONDITIONALLY there because an omitted
 * key survives the status merge and latches the previous reason — so "None" means
 * no failure, never `phase_not_ready:None`. This reader tolerance ships BEFORE the
 * composition emits the sentinel (akash-actuator-first-rollout: the reader accepts
 * the new shape before the writer produces it).
 */
function phaseNotReadyReason(status: Record<string, unknown>): string {
  const failureReason = asRecord(status.failure)?.reason;
  return typeof failureReason === "string" &&
    failureReason.length > 0 &&
    failureReason !== "None"
    ? `phase_not_ready:${failureReason}`
    : "phase_not_ready";
}

/** Compare live controller state with the exact Git-rendered desired state. */
export function assessComputeWorkloadReadiness(input: {
  readonly expected: unknown;
  readonly live: unknown;
}): ComputeWorkloadReadiness {
  const expected = asRecord(input.expected);
  // ONE_AUTHORITY_PER_WORKLOAD (bug.5148's verify twin): the deploy branch renders
  // exactly one kind per (node, env); the verify gate must speak BOTH kinds or every
  // Crossplane-node promote ends verify-red while the node serves (story.5016 toks4).
  if (expected?.kind === "XComputeWorkload") {
    return assessXComputeWorkloadReadiness(input);
  }
  const live = asRecord(input.live);
  const expectedMetadata = asRecord(expected?.metadata);
  const liveMetadata = asRecord(live?.metadata);
  const expectedSpec = asRecord(expected?.spec);
  const liveSpec = asRecord(live?.spec);
  const expectedBundle = asRecord(expectedSpec?.bundle);
  const status = asRecord(live?.status);

  if (
    !expected ||
    !live ||
    expected.apiVersion !== "compute.cogni.io/v1alpha1" ||
    live.apiVersion !== expected.apiVersion ||
    expected.kind !== "ComputeWorkload" ||
    live.kind !== expected.kind ||
    !expectedMetadata ||
    !liveMetadata ||
    !expectedSpec ||
    !liveSpec ||
    !expectedBundle
  ) {
    return { ready: false, reason: "invalid_resource_shape" };
  }
  if (
    liveMetadata.name !== expectedMetadata.name ||
    liveMetadata.namespace !== expectedMetadata.namespace
  ) {
    return { ready: false, reason: "identity_mismatch" };
  }
  // A resource mid-finalization still carries its last Ready status while the
  // lease behind it is being torn down; that is never a deployable state.
  if (liveMetadata.deletionTimestamp !== undefined) {
    return { ready: false, reason: "deletion_pending" };
  }
  if (stableJson(liveSpec) !== stableJson(expectedSpec)) {
    return { ready: false, reason: "desired_spec_pending" };
  }

  const generation = liveMetadata.generation;
  if (!Number.isInteger(generation) || Number(generation) < 1) {
    return { ready: false, reason: "invalid_generation" };
  }
  if (!status || status.observedGeneration !== generation) {
    return { ready: false, reason: "generation_pending" };
  }
  if (status.phase !== "Ready") {
    return { ready: false, reason: phaseNotReadyReason(status) };
  }
  if (stableJson(status.observedBundle) !== stableJson(expectedBundle)) {
    return {
      ready: false,
      reason: bundleMismatchReason(status.observedBundle, expectedBundle),
    };
  }

  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  const ready = conditions.some((value) => {
    const condition = asRecord(value);
    return (
      condition?.type === "Ready" &&
      condition.status === "True" &&
      condition.observedGeneration === generation
    );
  });
  return ready
    ? { ready: true }
    : { ready: false, reason: "ready_condition_pending" };
}

/**
 * XComputeWorkload readiness. Differences from the legacy CR, both load-bearing:
 * - Crossplane MUTATES the composite's spec (compositionRef, resourceRefs, defaulted
 *   fields), so strict spec equality would never converge — instead every key the
 *   rendered manifest declares must deep-equal the live value (expected ⊆ live).
 * - Serving truth is the composite's own contract: status.phase === "Ready" AND
 *   status.serving === true, plus the crossplane Ready/Synced conditions.
 */
function assessXComputeWorkloadReadiness(input: {
  readonly expected: unknown;
  readonly live: unknown;
}): ComputeWorkloadReadiness {
  const expected = asRecord(input.expected);
  const live = asRecord(input.live);
  const expectedMetadata = asRecord(expected?.metadata);
  const liveMetadata = asRecord(live?.metadata);
  const expectedSpec = asRecord(expected?.spec);
  const liveSpec = asRecord(live?.spec);
  const status = asRecord(live?.status);

  if (
    !expected ||
    !live ||
    expected.apiVersion !== "compute.cogni.io/v1alpha1" ||
    live.apiVersion !== expected.apiVersion ||
    live.kind !== "XComputeWorkload" ||
    !expectedMetadata ||
    !liveMetadata ||
    !expectedSpec ||
    !liveSpec
  ) {
    return { ready: false, reason: "invalid_resource_shape" };
  }
  if (
    liveMetadata.name !== expectedMetadata.name ||
    liveMetadata.namespace !== expectedMetadata.namespace
  ) {
    return { ready: false, reason: "identity_mismatch" };
  }
  if (liveMetadata.deletionTimestamp !== undefined) {
    return { ready: false, reason: "deletion_pending" };
  }
  // expected ⊆ live at EVERY level, not just the top: the candidate-a XRD defaults
  // nested subfields the materializer emits only partially (e.g.
  // spec.bootPolicy.bootDeadlineSeconds, spec.runtime.logPush) and k8s persists
  // them onto the live composite. A shallow per-key deep-equal treats those
  // defaults as drift and wedges on desired_spec_pending forever (bug.5263).
  if (!isDeepSubset(expectedSpec, liveSpec)) {
    return { ready: false, reason: "desired_spec_pending" };
  }
  if (!status) {
    return { ready: false, reason: "status_pending" };
  }
  // Staleness tie (same race the legacy path guards): after a spec update the live
  // spec matches instantly while status still describes the PRIOR generation's lease.
  // The composite has no top-level observedGeneration; its conditions carry one, and
  // observedBundle names what the actuator actually deployed.
  const generation = liveMetadata.generation;
  if (!Number.isInteger(generation) || Number(generation) < 1) {
    return { ready: false, reason: "invalid_generation" };
  }
  const expectedBundle = expectedSpec.bundle;
  if (expectedBundle !== undefined) {
    // FAIL CLOSED on an unobserved bundle. Projecting both sides onto {ref, source} fixes the
    // false NEGATIVE that artifacts caused, but it must not introduce a false POSITIVE: if
    // `status.observedBundle` is absent/empty (never reconciled) and the expected bundle happens
    // to carry no ref/source either, both sides project to {} and compare EQUAL — reporting a
    // deploy that never happened as Ready. A gate may only pass on POSITIVE evidence, so the
    // observed side must name a revision before any match counts. (Hole found in review of
    // #2454 by the poly node dev, reproduced by test before fixing.)
    const observedSha = asRecord(asRecord(status.observedBundle)?.source)?.sha;
    const observedNamesARevision =
      typeof observedSha === "string" && observedSha.length > 0;
    if (
      !observedNamesARevision ||
      stableJson(observedBundleView(status.observedBundle)) !==
        stableJson(observedBundleView(expectedBundle))
    ) {
      return {
        ready: false,
        reason: bundleMismatchReason(status.observedBundle, expectedBundle),
      };
    }
  }
  if (status.phase !== "Ready") {
    return { ready: false, reason: phaseNotReadyReason(status) };
  }
  if (status.serving !== true) {
    return { ready: false, reason: "not_serving" };
  }
  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  const conditionCurrent = (type: string): boolean =>
    conditions.some((value) => {
      const condition = asRecord(value);
      return (
        condition?.type === type &&
        condition.status === "True" &&
        condition.observedGeneration === generation
      );
    });
  if (!conditionCurrent("Synced") || !conditionCurrent("Ready")) {
    return { ready: false, reason: "ready_condition_pending" };
  }
  return { ready: true };
}

/**
 * Recursive partial-subset check: is `expected` present, and equal, everywhere it
 * is declared inside `live`? Honors the XComputeWorkload contract "expected ⊆ live":
 * - objects: every expected key must recursively subset-match live[key] (extra live
 *   keys — Crossplane's compositionRef/resourceRefs and XRD-defaulted subfields — are
 *   tolerated at every depth, not just the top level);
 * - arrays: same length, element-wise subset (services/expose are position-stable and
 *   fully rendered by the materializer, so an added or dropped element IS real drift);
 * - primitives (and null): strict value equality via stableJson.
 */
function isDeepSubset(expected: unknown, live: unknown): boolean {
  const expectedRecord = asRecord(expected);
  if (expectedRecord) {
    const liveRecord = asRecord(live);
    if (!liveRecord) return false;
    return Object.entries(expectedRecord).every(([key, value]) =>
      isDeepSubset(value, liveRecord[key])
    );
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(live) || live.length !== expected.length) return false;
    return expected.every((element, index) =>
      isDeepSubset(element, live[index])
    );
  }
  return stableJson(expected) === stableJson(live);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record)
      // Codepoint order, not localeCompare: a locale collator is not a
      // guaranteed total order, and a tie would sort by input order — which
      // differs between the rendered manifest and the apiserver's response.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortJson(child)])
  );
}
