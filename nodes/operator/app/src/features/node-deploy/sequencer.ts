// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/sequencer`
 * Purpose: The ONE blue/green deploy verb for declared workloads (task.5400, story.5127, design hub
 *   `node-service-delivery`). It sequences; the payer pays. Recovery of a lost app lease is the SAME
 *   verb: a new attempt of the same release.
 * Scope: Orchestration over ports (store, payer, edge, probes, secrets, chain, clock). Contains no IO
 *   of its own, so the REAL state machine runs unchanged over fakes in tests, over the Akash Console
 *   in local dev and over the private actuator in production.
 * Invariants:
 *   - ATTEMPT_ROW_BEFORE_CREATE: the attempt row (phase `planned`) is durable BEFORE the paid create.
 *     A dispatch marker is durable before native IO; resumed keys are observed before admission waits.
 *   - KEY_IS_NEVER_REUSED: every create takes the next attempt ordinal; a failed attempt's key is dead.
 *     An ambiguous create is RESOLVED through `observe(cogniKey)`, never blindly repeated.
 *   - PARK_AFTER_3: after 3 consecutive failed attempts of one release no further paid create happens
 *     until a new release arrives. No clock resets that count.
 *   - TERMINAL_ADMISSION: refusal fences every resumed phase before proof/cutover. Old paid effects
 *     keep observation/adoption and confirmed stateless cleanup; retained state keeps custody.
 *   - PROVE_BEFORE_CUTOVER: the edge never moves until the green lease serves the exact sha
 *     (`/version.buildSha`) and `/readyz` 200 through its provider ingress with the public Host header,
 *     within `proofMs` of lease creation; otherwise the NEW lease is closed and blue keeps serving.
 *     HOST_NOT_ROUTED (bug.5569): `/version` 404 on every probe for `hostNotRoutedMs` (the provider
 *     does not route our custom host) fails the proof at once (`host_not_routed`), the same close path.
 *   - DEFINITIVE_REFUSAL (bug.5569): a create refusal the payer marks `definitive` proves the create is
 *     no longer in flight. It only skips the in-flight grace; the attempt still runs the ONE cleanup
 *     chain (ORPHAN_GUARD: observe, then bind + close + confirm a found lease, else failed) in that tick.
 *   - NOT_BLUES_PROVIDER: a green lease that lands on blue's provider is a failed proof and is closed.
 *   - STOP_THEN_START (task.5409): when a green create is refused because blue's provider was the only
 *     bidder screening could pass, an `app` blue is closed (confirmed) BEFORE the next create, which then
 *     may land on blue's provider. At most once per release; never for `state`. Accepted downtime.
 *   - CUTOVER_IS_READ_BACK: a cutover counts only after the edge record reads back AND 8 consecutive
 *     public reads (host resolved at its zone's authoritative nameservers) return the exact sha.
 *   - CLOSE_IS_CONFIRMED: a lease counts as closed only after observe says closed AND chain truth
 *     (when wired) agrees. An unconfirmed close is retried by the janitor and alerted, never assumed.
 *   - STATE_IS_NEVER_AUTO_REPLACED: a `state` workload that ever went live is never recreated; loss
 *     only alerts.
 *   - LOST_MEANS_CHAIN_TRUTH: a lease is lost only when chain/observe say closed or insufficient_funds,
 *     or it fails its proof for `unhealthyLostMs` (15 min) straight. A single miss is not a loss.
 *   - ONE_RUNNER_PER_WORKLOAD: `step` and `reconcile` never overlap for one workload key.
 *   - IMAGE_PINNED_BEFORE_PAY (story.5137): a release recorded before node CI published its image
 *     (`spec.imagePending`) waits as `DependencyNotReady` (no attempt row, nothing paid) until the registry
 *     has `sha-<sha>`; the digest is then pinned WRITE-ONCE on the release, so every attempt deploys one
 *     image. After `imageAlertMs` unpublished it raises `alert/image_not_published`.
 *   - LATEST_RELEASE_WINS: the desired row points at the newest release of a workload, so an older release
 *     that never started (e.g. its image never appeared) is superseded and is never given an attempt.
 *   - ONE_EMIT_HELPER: every event (step, provider strike, alert) is written by `record`, which logs the
 *     Loki line AND appends the same step to the attempt's durable timeline; a failed append is logged
 *     and never fails a deploy decision.
 * Side-effects: IO via injected ports
 * @internal
 */

import type {
  BuiltImageResolverPort,
  ChainTruthPort,
  NodeCatalogPort,
  NodeRuntimeSecretsPort,
  PayerPort,
  ProbePort,
  SecretsPort,
  SequencerClock,
  SequencerLog,
  StorePort,
} from "@/ports";
import {
  type AttemptPatch,
  type AttemptPhase,
  type AttemptRow,
  type AttemptStep,
  BuiltImageRegistryError,
  buildCogniKey,
  buildIdentity,
  consecutiveFailures,
  IN_FLIGHT_PHASES,
  keyString,
  NodeRuntimeSecretsError,
  PayerError,
  type ReleaseRow,
  type WorkloadKey,
} from "@/ports";
import { isFleetOwnedRow } from "@/shared/node-registry/fleet-ownership";
import { selectReleaseBundle } from "./artifact-selection";
import { forwardedTcpEndpoint, resolveBinding } from "./bindings";
import {
  type EdgeRouter,
  HOST_ENVS,
  hostOwnedBy,
  workerHostRefusal,
} from "./edge";
import {
  nodeAppEnv,
  nodeAppSecretKeys,
  releaseIdentityEnv,
  workerEnv,
} from "./node-app-env";
import { nodeCatalogPolicy } from "./node-catalog-policy";
import {
  asQualificationFailure,
  checkQualification,
  QualificationFailure,
  qualificationChallenge,
  savedQualification,
  validationCode,
} from "./qualification";
import { ingressHostOf, publicHostOf, toPayerSpec } from "./spec";

export interface SequencerConfig {
  /** The Kubernetes namespace the sequencer runs in; part of every cogniKey. */
  readonly namespace: string;
  /**
   * The ONE deployment environment this sequencer serves (its DEPLOY_ENVIRONMENT). It lists and acts
   * only on desired rows of this env, so a row written for another env can never spend from this
   * wallet (CD4).
   */
  readonly environment: string;
  /** Lease must report active + an endpoint within this of lease creation. */
  readonly leaseReadyMs: number;
  /** Proof deadline, counted from lease creation (design: 10 min). */
  readonly proofMs: number;
  /**
   * HOST_NOT_ROUTED (bug.5569): when EVERY proof probe of `/version` through the provider ingress with
   * our Host answers HTTP 404 for this long, the provider does not route the custom domain. The attempt
   * fails `host_not_routed` at once instead of waiting out `proofMs`; any other proof failure keeps
   * the full `proofMs` window.
   */
  readonly hostNotRoutedMs: number;
  /** Bound on the public cutover read-back loop. */
  readonly publicMs: number;
  /** Consecutive exact-sha public reads that make a cutover (design: 8). */
  readonly publicStreak: number;
  /** How long blue is retained after cutover (design: 10 min; 2 min in tests). */
  readonly retainMs: number;
  /** One close-confirm poll window inside a single call. */
  readonly closeConfirmMs: number;
  /** After this long unconfirmed, a close raises an alert. */
  readonly closeAlertMs: number;
  readonly maxFailedAttempts: number;
  /**
   * After a create whose HTTP call died in transit (`network`), the actuator may STILL be executing it.
   * `observe` reports only found / not found, and for a key whose receipt is still `preparing` with no new
   * deployment it SETTLES the receipt as rolled back (resolveUncertain -> settleRollback), so observing a
   * create that is still in flight can settle it just before its POST lands and orphan the lease. The
   * attempt is therefore treated as UNRESOLVED (never failed, superseded or observed) for this long.
   */
  readonly inflightGraceMs: number;
  /** A live lease failing its proof this long is treated as lost (design: 15 min). */
  readonly unhealthyLostMs: number;
  /**
   * An unbound attempt whose `observe` keeps failing is left alone only this long (default 15 min since the
   * first `observe_unavailable`). Then it is failed `orphan_suspect:` with an alert, so the release can
   * park or retry. The lease is NOT claimed closed: nothing re-observes a `failed` unbound attempt, so a human acts on the
   * `orphan_suspect` alert (it carries the cogniKey).
   */
  readonly observeUnavailableMs: number;
  readonly pollMs: number;
  /**
   * A release whose image is still not in the registry this long after it was recorded raises
   * `alert/image_not_published` (once per throttle window). Nothing is paid while it waits (story.5137).
   */
  readonly imageAlertMs: number;
  /**
   * INTERIM provider allowlist for node APP creates (task.5405): the providers whose egress is
   * measured AND admitted to the shared substrate. Sent as `allowProviders` on every app create; the
   * actuator intersects it with its own allowlist and refuses on an empty intersection. State
   * workloads are never constrained by it. Absent/empty = no caller allowlist.
   */
  readonly appProviders?: readonly string[];
}

export const DEFAULT_SEQUENCER_CONFIG: Omit<
  SequencerConfig,
  "namespace" | "environment"
> = {
  leaseReadyMs: 240_000,
  proofMs: 600_000,
  hostNotRoutedMs: 60_000,
  publicMs: 300_000,
  publicStreak: 8,
  retainMs: 600_000,
  closeConfirmMs: 90_000,
  closeAlertMs: 900_000,
  maxFailedAttempts: 3,
  inflightGraceMs: 900_000,
  unhealthyLostMs: 900_000,
  observeUnavailableMs: 900_000,
  pollMs: 3_000,
  imageAlertMs: 1_800_000,
};

/**
 * What a node APP needs beyond its declaration to run like it did on the Crossplane lane (task.5405).
 * Absent (dev harness, unit tests of the state machine) = apps get only `RELEASE_SHA` and bindings.
 */
export interface NodeAppRuntimeDeps {
  readonly secrets: NodeRuntimeSecretsPort;
  readonly catalog: NodeCatalogPort;
  /** `vm_host_for_env` of the environment VM; absent omits the substrate env block. */
  readonly substrateHost?: string | undefined;
}

export interface SequencerDeps {
  readonly store: StorePort;
  readonly payer: PayerPort;
  /** Undefined when no edge credentials are configured: http apps are then refused BEFORE paying. */
  readonly edge: EdgeRouter | undefined;
  /** Invalid fresh DNS authority does not revoke paid-effect recovery ownership. */
  readonly httpAdmissionRefusal?: "workload_zone_not_configured";
  readonly probe: ProbePort;
  readonly secrets: SecretsPort;
  readonly runtime?: NodeAppRuntimeDeps;
  readonly chain?: ChainTruthPort;
  /**
   * Resolves a pending release image (`<repo>:sha-<sha>`) to its digest (story.5137). Absent (dev harness):
   * a release with a pending image waits as `DependencyNotReady` and is never created.
   */
  readonly images?: BuiltImageResolverPort;
  readonly clock: SequencerClock;
  readonly log: SequencerLog;
  readonly config: SequencerConfig;
}

export type StepOutcome =
  | "idle"
  | "converged"
  | "driven"
  | "parked"
  | "superseded"
  | "state_protected"
  | "waiting_dependency"
  | "close_pending"
  | "busy";

export type ReconcileOutcome =
  | "none"
  | "healthy"
  | "unhealthy_waiting"
  | "lost_state_alert"
  | "lost_app"
  | "busy";

const ALERT_THROTTLE_MS = 600_000;
const GRACE_LOG_THROTTLE_MS = 60_000;
/** The operator's own workloads (the canary) take no node-app env: they are not a node app. */
const OPERATOR_NODE_SLUG = "operator";
/** The actuator wire accepts at most 16 `excludeProviders`. */
const MAX_EXCLUDED_PROVIDERS = 16;
/** LANE_MEMORY (story.5137): strikes on one lane within this window, across releases, are remembered. */
const STRIKE_MEMORY_MS = 24 * 60 * 60_000;
/** LANE_MEMORY: a provider is excluded by memory after this many remembered strikes. */
const STRIKE_MEMORY_MIN = 2;
/** LANE_MEMORY: the struck-after-bind failures (`strike` + `failAttempt` write this error prefix). */
const STRIKE_MEMORY_ERROR = /^(proof_timeout|host_not_routed):/;
/** LANE_MEMORY: phases of an attempt that served the lane. Memory never names such a provider (no lockout). */
const SERVED_PHASES: readonly AttemptPhase[] = [
  "active",
  "retiring",
  "retired",
  "lost",
];
/** The actuator wire accepts at most 16 `allowProviders`. */
const MAX_ALLOWED_PROVIDERS = 16;

class DependencyNotReady extends Error {}
class InvalidArtifactSet extends Error {}

interface ResolvedRuntime {
  readonly env: Record<string, string>;
  readonly companionEnvs?: Record<string, Record<string, string>>;
  /** Catalog `required_placement_countries[<env>]`; empty = unconstrained. */
  readonly requiredCountryCodes: readonly string[];
  /** True when the env is a non-operator node app's full runtime env (`nodeAppEnv`). */
  readonly nodeApp: boolean;
}

export class NodeDeploySequencer {
  private readonly running = new Set<string>();
  private readonly lastAlertAt = new Map<string, number>();
  private readonly lastGraceLogAt = new Map<string, number>();
  /** Last persisted step signature per attempt, so a poll loop writes one timeline row, not hundreds. */
  private readonly lastStep = new Map<string, string>();

  constructor(private readonly d: SequencerDeps) {}

  // -------------------------------------------------------------------------------------------
  // Loops
  // -------------------------------------------------------------------------------------------

  /** One pass over every desired workload; runs workloads concurrently, never one twice. */
  async tick(): Promise<void> {
    const desired = await this.d.store.listDesired(this.d.config.environment);
    await Promise.all(
      desired.map((row) =>
        this.step(row).catch((error: unknown) =>
          this.loopError(row, "step", error)
        )
      )
    );
  }

  /** One reconcile pass (design: every 60 s). */
  async reconcileAll(): Promise<void> {
    const desired = await this.d.store.listDesired(this.d.config.environment);
    await Promise.all(
      desired.map((row) =>
        this.reconcile(row).catch((error: unknown) =>
          this.loopError(row, "reconcile", error)
        )
      )
    );
  }

  // -------------------------------------------------------------------------------------------
  // step: converge the workload to its desired release
  // -------------------------------------------------------------------------------------------

  async step(key: WorkloadKey): Promise<StepOutcome> {
    return (await this.exclusive(key, () => this.stepLocked(key))) ?? "busy";
  }

  private async stepLocked(key: WorkloadKey): Promise<StepOutcome> {
    if (key.env !== this.d.config.environment) return "idle";
    const desired = await this.d.store.getDesired(key);
    if (!desired || desired.state !== "running") return "idle";
    const release = await this.d.store.getRelease(desired.releaseId);
    if (!release) {
      await this.alert(key, undefined, undefined, "desired_release_missing");
      return "idle";
    }

    await this.janitor(key);
    const all = await this.d.store.attemptsFor(key);

    const inflight = all.find((a) => IN_FLIGHT_PHASES.includes(a.phase));
    const active = all.find((a) => a.phase === "active");
    if (desired.gameDayRequestedAt)
      await this.gameDayKill(key, release, active, inflight);
    if (inflight) {
      const inflightRelease =
        inflight.releaseId === release.id
          ? release
          : await this.d.store.getRelease(inflight.releaseId);
      if (!inflightRelease) return "idle";
      // A newer release replaces anything not yet at the edge; a `proven` attempt finishes its cutover.
      if (inflight.releaseId !== release.id && inflight.phase !== "proven") {
        await this.failAttempt(key, inflightRelease, inflight, "superseded");
        return "superseded";
      }
      await this.drive(key, inflightRelease, inflight, active);
      return "driven";
    }

    if (active && active.releaseId === release.id) return "converged";
    // Existing paid attempts above retain recovery authority, never activation authority after
    // terminal refusal. Every tick/restart reads the authoritative release.
    if (release.admissionRefusal) return "parked";

    if (release.spec.kind === "state") {
      const everLive = all.some((a) =>
        ["active", "lost", "retiring", "retired"].includes(a.phase)
      );
      if (everLive) {
        // STATE_IS_NEVER_AUTO_REPLACED: a live state lease that is gone is an alert, not a create.
        return "state_protected";
      }
    }

    if (all.some((a) => a.phase === "closing")) {
      // Never launch another paid lease over one we cannot prove closed.
      return "close_pending";
    }

    const ofRelease = all.filter((a) => a.releaseId === release.id);
    if (ofRelease.some((a) => a.error?.startsWith("artifact_bundle_invalid")))
      return "parked";
    const failures = consecutiveFailures(ofRelease);
    // LAST_RESORT_STOP (task.5409): when the release's last refusal shows blue's provider as the only bidder
    // screening could pass, the park limit grants exactly ONE stop-then-start attempt. Parking first would
    // leave the node on blue forever (blue never moves, green never places). After that attempt, blue is
    // retired, so the predicate is false and a further failure parks as usual.
    const lastResort =
      !release.spec.health?.qualification &&
      failures === this.d.config.maxFailedAttempts &&
      (await this.stopThenStartVerdict(key, release, ofRelease, active)) ===
        "eligible";
    if (failures >= this.d.config.maxFailedAttempts && !lastResort) {
      // Attached to the release's newest attempt so the park is a durable step on its timeline:
      // `release-view` reads `alert/release_parked` as the sequencer's own verdict.
      await this.alert(key, release, ofRelease[0], "release_parked", {
        failedAttempts: consecutiveFailures(ofRelease),
      });
      return "parked";
    }

    let deployable: ReleaseRow;
    try {
      // The image first: a pending image (`<repo>:sha-<sha>`) is resolved to a digest ONCE, pinned
      // write-once on the release, and only then can an attempt exist (ALWAYS_DEFER, story.5137).
      deployable = await this.pinImage(key, release);
      if (deployable.admissionRefusal) return "parked";
      await this.resolveEnv(key, deployable);
    } catch (error) {
      if (error instanceof InvalidArtifactSet) {
        // Admission failed: attribute the refusal to the existing release intent. An attempt
        // identity is allocated only after the entire selected artifact set is admitted.
        await this.persistAdmissionRefusal(release, error);
        await this.alert(key, release, undefined, "release_parked", {
          reason: "artifact_bundle_invalid",
          detail: error.message,
        });
        return "parked";
      }
      if (error instanceof DependencyNotReady) {
        await this.emit(key, release, undefined, "dependency", "waiting", {
          reason: error.message,
        });
        return "waiting_dependency";
      }
      throw error;
    }

    const allocateAttempt = () =>
      this.d.store.insertAttempt(release.id, (n) =>
        buildCogniKey({
          namespace: this.d.config.namespace,
          nodeId: key.nodeId,
          workload: key.workload,
          releaseId: release.id,
          attempt: n,
        })
      );
    try {
      await this.assertNewAppHost(key, deployable);
    } catch (error) {
      const refused = await allocateAttempt();
      await this.emit(key, release, refused, "attempt_planned", "ok", {
        blue: active?.externalName,
      });
      await this.failAttempt(key, deployable, refused, errText(error), {
        createEnded: true,
      });
      return "driven";
    }
    let blue = active;
    // STOP_THEN_START (task.5409): blue's provider was the only bidder that could pass screening, so a
    // green beside blue can never be placed. Close blue first (accepted downtime), then create.
    // A useful-work capability requires blue to survive failed or unknown qualification.
    const stop = release.spec.health?.qualification
      ? "none"
      : await this.stopThenStart(key, release, ofRelease, active);
    if (stop === "unconfirmed") return "close_pending";
    if (stop === "stopped") blue = undefined;

    const attempt = await allocateAttempt();
    await this.emit(key, release, attempt, "attempt_planned", "ok", {
      blue: blue?.externalName,
    });
    await this.drive(key, deployable, attempt, blue, true);
    return "driven";
  }

  private async persistAdmissionRefusal(
    release: ReleaseRow,
    error: InvalidArtifactSet
  ): Promise<void> {
    try {
      const refused = await this.d.store.refuseAdmission(release.id, {
        reason: `artifact_bundle_invalid: ${error.message}`.slice(0, 600),
        at: new Date(this.d.clock.now()).toISOString(),
      });
      if (refused.admissionRefusal) return;
    } catch {
      // A lost write response grants no authority. Only durable readback confirms the verdict.
    }
    const readback = await this.d.store.getRelease(release.id);
    if (!readback?.admissionRefusal)
      throw new Error(
        "admission refusal outcome unknown; awaiting durable readback"
      );
  }

  /**
   * STOP_THEN_START (task.5409, CEO ruling 2026-11-03: a node may go DOWN during a switch). Blue/green
   * excludes blue's provider, because one Akash provider cannot serve the same custom host from two
   * leases. When that provider is the ONLY one that can pass screening, every green create is refused
   * and the lane can never ship again. So, for an `app` only (a state lease is never stopped):
   *  - trigger: the release's newest attempt failed with a create refusal in which bids arrived, none
   *    passed screening, and blue's provider was refused only as `already_tried` (the actuator's
   *    exclusion verdict, `akash-provider-screen.ts` `rejectionFor`). With no bound-state exclusion the
   *    caller's exclude list is exactly {blue}, so `already_tried=N>0` names blue; otherwise the bid
   *    roster must name blue's address as `already_tried`.
   *  - action: close blue chain-confirmed (`closeAndConfirm`), mark it `retired`, and let the next create
   *    run with no blue, so blue's provider is no longer excluded. The edge keeps pointing at the
   *    closed lease until green's proof moves it (the accepted downtime window).
   *  - an unconfirmed close stops here: no create while blue may still be live (`close_unconfirmed`).
   *  - at most once per release: after the stop the workload has no active blue, so it cannot trigger
   *    again until this release (or a newer one) serves. If green then fails, the normal park applies.
   * Never for a first release (no blue) or a lane where another provider passed screening.
   */
  /**
   * The read-only half of stop-then-start: `eligible` when blue may be closed so green can take its provider,
   * `not_admitted` when blue's provider is the only screened bidder but is no longer admitted (closing blue would
   * trade a live node for a dead one), `none` otherwise. ONE predicate for both the park-limit decision and the act.
   */
  private async stopThenStartVerdict(
    key: WorkloadKey,
    release: ReleaseRow,
    ofRelease: readonly AttemptRow[],
    blue: AttemptRow | undefined
  ): Promise<"eligible" | "not_admitted" | "none"> {
    if (release.spec.kind !== "app") return "none";
    if (!blue?.provider || !blue.externalName || blue.releaseId === release.id)
      return "none";
    const newest = ofRelease[0];
    if (newest?.phase !== "failed") return "none";
    const stateExcluded = await this.excludedProviders(key, release, undefined);
    // HAIRPIN_RULE still holds: if blue's provider also hosts a bound state lease, reopening it is useless.
    if (stateExcluded.includes(blue.provider)) return "none";
    // What the refused create excluded besides blue: bound state providers AND this release's failed-after-
    // bind tries (bug.5569). Only when that is empty was `already_tried>=1` blue's; otherwise the roster must
    // name blue itself, so a failed try's provider can never close blue.
    const others = await this.excludedProviders(key, release, undefined, true);
    // LANE_MEMORY (story.5137) depends on the clock, so a recompute can differ from what the refused create
    // actually excluded (a strike aged out of the 24h window). The refused attempt's own `providers_excluded`
    // step is that record: when it names anything besides blue, the shortcut is off. A missing step (the
    // timeline is best-effort) only falls back to the recompute; the record can make the check stricter,
    // never looser.
    const refusedExcluded = [...newest.steps]
      .reverse()
      .find((s) => s.step === "providers_excluded")?.reason;
    const onlyBlueExcluded =
      others.length === 0 &&
      (refusedExcluded === undefined || refusedExcluded === blue.provider);
    if (
      !blueWasOnlyScreenedBidder(newest.error, blue.provider, onlyBlueExcluded)
    )
      return "none";
    // Only an app blue is ever stopped.
    const blueRelease = await this.d.store.getRelease(blue.releaseId);
    if (blueRelease?.spec.kind !== "app") return "none";
    const admitted = (this.d.config.appProviders ?? []).slice(
      0,
      MAX_ALLOWED_PROVIDERS
    );
    if (admitted.length > 0 && !admitted.includes(blue.provider))
      return "not_admitted";
    return "eligible";
  }

  private async stopThenStart(
    key: WorkloadKey,
    release: ReleaseRow,
    ofRelease: readonly AttemptRow[],
    blue: AttemptRow | undefined
  ): Promise<"none" | "stopped" | "unconfirmed"> {
    const verdict = await this.stopThenStartVerdict(
      key,
      release,
      ofRelease,
      blue
    );
    if (verdict === "none" || !blue?.provider || !blue.externalName)
      return "none";
    const newest = ofRelease[0] as AttemptRow;
    if (verdict === "not_admitted") {
      await this.alert(key, release, newest, "stop_then_start_refused", {
        provider: blue.provider,
        reason: `blue provider ${blue.provider} is no longer admitted (appProviders); blue kept, no stop`,
      });
      return "none";
    }
    const blueRelease = await this.d.store.getRelease(blue.releaseId);
    if (!blueRelease) return "none";

    const reason = `blue provider ${blue.provider} is the only bidder that passes screening; closing blue ${blue.externalName} before green (accepted downtime)`;
    await this.emit(key, release, newest, "stop_then_start", "closing_blue", {
      blueDseq: blue.externalName,
      provider: blue.provider,
      reason,
    });
    await this.alert(key, release, newest, "stop_then_start", {
      blueDseq: blue.externalName,
      provider: blue.provider,
      reason,
    });
    if (!(await this.closeAndConfirm(blue))) {
      await this.alert(key, release, blue, "close_unconfirmed", {
        reason: "stop_then_start: blue close not confirmed; no green create",
      });
      return "unconfirmed";
    }
    const retired = await this.d.store.updateAttempt(blue.id, {
      phase: "retired",
    });
    await this.emit(key, blueRelease, retired, "old_closed", "ok", {
      dseq: retired.externalName,
      verified: true,
      reason: "stop_then_start",
    });
    await this.emit(key, release, newest, "stop_then_start", "blue_closed", {
      blueDseq: retired.externalName,
      provider: blue.provider,
    });
    return "stopped";
  }

  /**
   * ALWAYS_DEFER (story.5137): a release recorded before node CI published its image carries
   * `<repo>:sha-<sha>` with `imagePending`. This resolves the digest through the registry port and pins it
   * write-once on the release (`pinResolvedImage`), so every attempt of the release deploys ONE image and a
   * mutable tag never reaches a paid create. Until the image exists it is `DependencyNotReady`: no attempt
   * row, nothing paid, retried next tick; past `imageAlertMs` it also raises `alert/image_not_published`.
   * A release whose image is already pinned (the store returns it normalized) passes through untouched.
   */
  private async pinImage(
    key: WorkloadKey,
    release: ReleaseRow
  ): Promise<ReleaseRow> {
    const w = release.spec;
    if ((w.companions?.length || w.health?.qualification) && !w.artifactPlan)
      throw new InvalidArtifactSet(
        "qualified service set has no frozen artifact plan"
      );
    if (w.artifactPlan) {
      if (w.artifactPlan.bundleDigest && release.resolvedImage) {
        await this.checkSelectedImages(release.spec);
        return release;
      }
      if (!this.d.images?.resolveArtifactBundle)
        throw new DependencyNotReady("no bundle resolver configured");
      const acceptedDigest = await this.d.store.acceptedBundle(release);
      try {
        const publication = await this.d.images.resolveArtifactBundle({
          imageRepository: w.artifactPlan.imageRepository,
          sourceSha: release.sourceSha,
          ...(acceptedDigest ? { acceptedDigest } : {}),
        });
        if (!publication)
          throw new DependencyNotReady(
            "complete CI bundle is not published yet"
          );
        let spec: ReleaseRow["spec"];
        try {
          spec = selectReleaseBundle(release, publication);
        } catch {
          throw new InvalidArtifactSet(
            "bundle identity or service coverage refused"
          );
        }
        await this.checkSelectedImages(spec);
        let sealed: ReleaseRow | undefined;
        try {
          sealed = await this.d.store.pinResolvedBundle(release.id, spec);
        } catch {
          // A lost COMMIT reply is unknown, not permission to resolve tags or create another set.
          try {
            sealed = await this.d.store.getRelease(release.id);
          } catch {
            /* next tick reads durable intent */
          }
          if (
            !sealed?.resolvedImage ||
            !sealed.spec.artifactPlan?.bundleDigest ||
            !sealed.spec.artifactPlan.selectedImages
          )
            throw new DependencyNotReady(
              "bundle seal outcome unknown; awaiting durable readback"
            );
        }
        if (!sealed)
          throw new DependencyNotReady(
            "another environment accepted a bundle; retry its digest"
          );
        // CAS can return a concurrently accepted winner. Check the actual set we will create.
        if (
          JSON.stringify(sealed.spec.artifactPlan?.selectedImages) !==
          JSON.stringify(spec.artifactPlan?.selectedImages)
        )
          await this.checkSelectedImages(sealed.spec);
        return sealed;
      } catch (e) {
        if (e instanceof BuiltImageRegistryError) {
          if (e.invalid) throw new InvalidArtifactSet(e.message);
          throw new DependencyNotReady("bundle registry unavailable");
        }
        throw e;
      }
    }
    if (!w.imagePending) return release;
    const m = /^(.+):sha-([0-9a-f]{40})$/u.exec(w.image);
    if (!m?.[1] || !m[2])
      throw new DependencyNotReady(`pending image ${w.image} is malformed`);
    if (!this.d.images)
      throw new DependencyNotReady("no image resolver is configured");
    let digest: string | null;
    try {
      digest = await this.d.images.resolveBuiltImage({
        imageRepository: m[1],
        sourceSha: m[2],
      });
    } catch (error) {
      if (error instanceof BuiltImageRegistryError)
        throw new DependencyNotReady(
          `image registry unavailable: ${error.message.slice(0, 200)}`
        );
      throw error;
    }
    if (digest === null) {
      const waitedMs = this.d.clock.now() - release.createdAt.getTime();
      if (waitedMs >= this.d.config.imageAlertMs)
        await this.alert(key, release, undefined, "image_not_published", {
          waitedMs,
          image: w.image,
        });
      throw new DependencyNotReady(`image ${w.image} is not published yet`);
    }
    return this.d.store.pinResolvedImage(release.id, digest);
  }

  private async checkSelectedImages(spec: ReleaseRow["spec"]): Promise<void> {
    const images = spec.artifactPlan?.selectedImages;
    if (!images || !this.d.images?.checkImageManifests)
      throw new DependencyNotReady(
        "selected image manifest reader unavailable"
      );
    try {
      if (!(await this.d.images.checkImageManifests(Object.values(images))))
        throw new DependencyNotReady(
          "selected image digest is not published or readable"
        );
    } catch (e) {
      if (e instanceof BuiltImageRegistryError) {
        if (e.invalid) throw new InvalidArtifactSet(e.message);
        throw new DependencyNotReady("selected image registry unavailable");
      }
      throw e;
    }
  }

  /**
   * GAME DAY (design: the weekly kill that proves unattended recovery). Consumes the durable intent an
   * operator verb recorded: close the ACTIVE app lease through the payer (the actuator pays), leave
   * desired state and the release untouched, and do NOT mark the attempt. Recovery is the ordinary
   * path: reconcile observes the chain-confirmed close, marks the lease lost, and `step` redeploys the
   * same release. A state workload is never killed. While another attempt is in flight (a cutover may
   * be moving the edge) the intent waits.
   */
  private async gameDayKill(
    key: WorkloadKey,
    release: ReleaseRow,
    active: AttemptRow | undefined,
    inflight: AttemptRow | undefined
  ): Promise<void> {
    if (release.spec.kind === "state") {
      await this.alert(key, release, active, "game_day_refused_state");
      await this.d.store.clearGameDay(key);
      return;
    }
    if (inflight) return; // not mid-release: the intent stays durable and is retried next tick
    if (!active?.externalName) {
      await this.emit(key, release, active, "game_day_kill", "no_active_lease");
      await this.d.store.clearGameDay(key);
      return;
    }
    try {
      await this.d.payer.delete({
        cogniKey: active.cogniKey,
        externalName: active.externalName,
      });
    } catch (error) {
      // Keep the intent: the delete may not have happened; the next tick retries.
      await this.emit(key, release, active, "game_day_kill", "delete_failed", {
        error: errText(error),
      });
      return;
    }
    await this.record("warn", "node_deploy_game_day_kill", active, {
      component: "node-deploy-sequencer",
      nodeId: key.nodeId,
      env: key.env,
      workload: key.workload,
      releaseId: release.id,
      attempt: active.attempt,
      dseq: active.externalName,
      provider: active.provider,
      step: "game_day_kill",
      outcome: "deleted",
      sourceSha: release.sourceSha,
    });
    await this.d.store.clearGameDay(key);
  }

  /** Run one attempt forward as far as it can go in this call. */
  private async drive(
    key: WorkloadKey,
    release: ReleaseRow,
    start: AttemptRow,
    blue: AttemptRow | undefined,
    freshAttempt = false
  ): Promise<void> {
    if (release.admissionRefusal) {
      if (!freshAttempt && this.createMayStillBeInFlight(start)) return;
      if (release.spec.kind === "app") {
        // The existing orphan guard observes, adopts and confirms closure under the original key.
        // It also preserves the grace window while a paid create may still be running.
        await this.failAttempt(
          key,
          release,
          start,
          release.admissionRefusal.reason
        );
      } else {
        // Retained state cannot be destroyed by an admission verdict. Keep observation/custody,
        // but grant neither proof nor activation. No new create or replacement is authorized.
        if (this.createMayStillBeInFlight(start)) return;
        try {
          const obs = await this.d.payer.observe({
            cogniKey: start.cogniKey,
            ...(start.externalName ? { externalName: start.externalName } : {}),
          });
          if (obs.found && obs.resource && !start.externalName)
            await this.bindLease(key, release, start, obs.resource);
        } catch (error) {
          await this.emit(
            key,
            release,
            start,
            "admission_refused",
            "observe_unavailable",
            {
              error: errText(error),
            }
          );
        }
        await this.alert(
          key,
          release,
          start,
          "admission_refused_state_retained",
          {
            reason: release.admissionRefusal.reason,
          }
        );
      }
      return;
    }
    let a = start;
    let recoveryPending = false;
    if (a.phase === "planned") {
      if (a.error?.startsWith(REFUSED_PREFIX)) {
        await this.failAttempt(key, release, a, a.error);
        return;
      }
      // A dispatch marker survives loss before bindLease or the catch handler. Legacy
      // unmarked rows get the same grace: their previous runner may still be paying.
      if (!freshAttempt && this.createMayStillBeInFlight(a)) {
        await this.emitGrace(key, release, a, "create", "inflight_grace", {
          graceMs: this.d.config.inflightGraceMs,
        });
        recoveryPending = true;
      }
      if (!freshAttempt && !recoveryPending) {
        try {
          const obs = await this.d.payer.observe({ cogniKey: a.cogniKey });
          if (obs.found && obs.resource) {
            await this.emit(
              key,
              release,
              a,
              "create",
              "adopted_after_ambiguity",
              {
                dseq: obs.resource.externalName,
              }
            );
            a = await this.bindLease(key, release, a, obs.resource);
          } else if (a.error?.startsWith("ambiguous")) {
            await this.failAttempt(
              key,
              release,
              a,
              "ambiguous create resolved to nothing; next ordinal"
            );
            return;
          }
        } catch (error) {
          a = await this.observeUnavailable(
            key,
            release,
            a,
            "create",
            "planned create unresolved",
            error
          );
          recoveryPending = true;
        }
      }
    }
    // New admission cannot suppress native recovery. Missing publication holds the
    // owned allocation without qualification, traffic or another attempt.
    if (release.spec.artifactPlan) {
      try {
        await this.checkSelectedImages(release.spec);
      } catch (error) {
        if (error instanceof DependencyNotReady) {
          await this.emit(key, release, a, "dependency", "waiting", {
            reason: error.message,
          });
          return;
        }
        if (error instanceof InvalidArtifactSet) {
          await this.persistAdmissionRefusal(release, error);
          const refused = await this.d.store.getRelease(release.id);
          if (!refused?.admissionRefusal)
            throw new Error("admission refusal readback missing");
          await this.drive(key, refused, a, blue, freshAttempt);
          return;
        }
        throw error;
      }
    }
    if (recoveryPending) return;
    if (a.phase === "planned") a = await this.doCreate(key, release, a, blue);
    if (a.phase === "created") a = await this.awaitLease(key, release, a, blue);
    if (a.phase === "proving") a = await this.prove(key, release, a);
    if (a.phase === "proven") await this.cutover(key, release, a, blue);
  }

  // ---- create ---------------------------------------------------------------------------------

  /**
   * The env (and placement policy) one create needs. A node APP of a non-operator node gets the SAME env
   * the Crossplane lane rendered, with OpenBao as custodian (`nodeAppEnv`); then `RELEASE_SHA`; then
   * its declared state bindings, which win (CD2). Anything that cannot be resolved is
   * `DependencyNotReady`: no attempt row, no paid create, retried next tick (NO_HALF_ENV).
   */
  private async resolveEnv(
    key: WorkloadKey,
    release: ReleaseRow
  ): Promise<ResolvedRuntime> {
    const w = release.spec;
    const env: Record<string, string> = {};
    let requiredCountryCodes: readonly string[] = [];
    let nodeApp = false;
    let companionEnvs: Record<string, Record<string, string>> = {};
    if (w.kind === "app") {
      const node = await this.nodeAppRuntime(key, release);
      if (node) {
        Object.assign(env, node.env);
        requiredCountryCodes = node.requiredCountryCodes;
        nodeApp = node.nodeApp;
        companionEnvs = node.companionEnvs ?? {};
      }
      Object.assign(env, releaseIdentityEnv(release.sourceSha));
    }
    if (w.kind === "state") {
      env.POSTGRES_PASSWORD = await this.d.secrets.ensureStatePassword(key);
    }
    const states = [...new Set(w.bindings.map((b) => b.workload))];
    for (const stateName of states) {
      const stateKey = { ...key, workload: stateName };
      const desired = await this.d.store.getDesired(stateKey);
      const stateRelease = desired
        ? await this.d.store.getRelease(desired.releaseId)
        : undefined;
      const stateAttempts = await this.d.store.attemptsFor(stateKey);
      const live = stateAttempts.find((a) => a.phase === "active");
      const password = await this.d.secrets.getStatePassword(stateKey);
      if (!stateRelease || !live || !password)
        throw new DependencyNotReady(
          `state workload ${stateName} has no active lease or no password yet`
        );
      for (const b of resolveBinding(w, {
        name: stateName,
        endpoints: live.endpoints,
        password,
      }))
        env[b.env] = b.value;
    }
    return { env, requiredCountryCodes, nodeApp, companionEnvs };
  }

  private async nodeAppRuntime(
    key: WorkloadKey,
    release: ReleaseRow
  ): Promise<
    | {
        env: Record<string, string>;
        requiredCountryCodes: string[];
        nodeApp: boolean;
        companionEnvs?: Record<string, Record<string, string>>;
      }
    | undefined
  > {
    const rt = this.d.runtime;
    if (!rt) {
      if (release.spec.companions?.length)
        throw new DependencyNotReady(
          "private companions require scoped runtime secrets"
        );
      return undefined;
    }
    const w = release.spec;
    const entry = await rt.catalog.entryFor(key.nodeId);
    if (!entry)
      throw new DependencyNotReady(
        `node ${key.nodeId} is not in this operator image's catalog; its runtime env and placement cannot be resolved`
      );
    if (entry.slug === OPERATOR_NODE_SLUG) return undefined;
    const publicHost = publicHostOf(w);
    if (!publicHost)
      throw new DependencyNotReady(
        `app workload ${w.name} declares no public host`
      );
    let policy: ReturnType<typeof nodeCatalogPolicy>;
    try {
      policy = nodeCatalogPolicy(entry.row, key.env);
    } catch (error) {
      throw new DependencyNotReady(`catalog policy: ${errText(error)}`);
    }
    if (w.runtimeProfile === "worker") {
      // WORKER_GETS_ITS_OWN_SECRETS_ONLY (task.5272): no node-app profile, no substrate, no database.
      let workerBucket: Readonly<Record<string, string>>;
      try {
        workerBucket = await rt.secrets.read(
          key.env,
          entry.slug,
          w.secretKeys ?? []
        );
      } catch (error) {
        if (error instanceof NodeRuntimeSecretsError)
          throw new DependencyNotReady(
            `node runtime secrets ${error.code}${error.keys.length > 0 ? `: ${error.keys.join(", ")}` : ""}`
          );
        throw error;
      }
      try {
        return {
          env: workerEnv({
            env: key.env,
            sourceSha: release.sourceSha,
            port: w.port,
            secretKeys: w.secretKeys ?? [],
            secrets: workerBucket,
          }),
          requiredCountryCodes: [...policy.requiredCountryCodes],
          nodeApp: false,
        };
      } catch (error) {
        throw new DependencyNotReady(errText(error));
      }
    }
    const boundEnvNames = w.bindings.map((b) => b.env);
    let bucket: Readonly<Record<string, string>>;
    try {
      bucket = await rt.secrets.read(key.env, entry.slug, [
        ...new Set([
          ...nodeAppSecretKeys(w.secretKeys, boundEnvNames),
          ...(w.companions ?? []).flatMap((c) => c.secretKeys ?? []),
        ]),
      ]);
    } catch (error) {
      if (error instanceof NodeRuntimeSecretsError)
        throw new DependencyNotReady(
          `node runtime secrets ${error.code}${error.keys.length > 0 ? `: ${error.keys.join(", ")}` : ""}`
        );
      throw error;
    }
    try {
      return {
        env: nodeAppEnv({
          env: key.env,
          slug: entry.slug,
          nodeId: key.nodeId,
          sourceSha: release.sourceSha,
          publicHost,
          port: w.port,
          substrateHost: rt.substrateHost,
          databasePoolLimits: policy.databasePoolLimits,
          secretKeys: w.secretKeys,
          secrets: bucket,
          boundEnvNames,
        }),
        requiredCountryCodes: [...policy.requiredCountryCodes],
        nodeApp: true,
        companionEnvs: Object.fromEntries(
          (w.companions ?? []).map((c) => [
            c.name,
            workerEnv({
              env: key.env,
              sourceSha: release.sourceSha,
              port: c.port,
              secretKeys: c.secretKeys ?? [],
              secrets: bucket,
            }),
          ])
        ),
      };
    } catch (error) {
      throw new DependencyNotReady(errText(error));
    }
  }

  /**
   * HAIRPIN_RULE: providers a new app attempt must NOT land on — blue's provider (two leases on one
   * ingress cannot both claim a host) and the provider of every BOUND state workload's active lease (an
   * app cannot reach a state lease's public forwarded port on its own provider: production canary v2
   * served /version but /readyz was 503 db_unreachable). With `withFailedTries` (a new create only), also
   * the provider of every earlier attempt of THIS release that failed or was lost AFTER binding a lease
   * (proof_timeout, failed proof, lease lost): a provider whose egress is not admitted must not be
   * retried (bug.5569). A refused create bound no provider, so it adds none. Also with `withFailedTries`,
   * the LANE MEMORY (story.5137): see `rememberedStrikes`. Deduped, blue first, capped at the wire's 16.
   */
  private async excludedProviders(
    key: WorkloadKey,
    release: ReleaseRow,
    blue: AttemptRow | undefined,
    withFailedTries = false
  ): Promise<string[]> {
    return (await this.exclusion(key, release, blue, withFailedTries))
      .providers;
  }

  /** `excludedProviders`, plus which entries came from the lane memory (for the one log line). */
  private async exclusion(
    key: WorkloadKey,
    release: ReleaseRow,
    blue: AttemptRow | undefined,
    withFailedTries: boolean
  ): Promise<{ providers: string[]; remembered: string[] }> {
    const w = release.spec;
    const providers: (string | undefined)[] = [blue?.provider];
    for (const stateName of new Set(w.bindings.map((b) => b.workload))) {
      const stateAttempts = await this.d.store.attemptsFor({
        ...key,
        workload: stateName,
      });
      providers.push(stateAttempts.find((a) => a.phase === "active")?.provider);
    }
    const lane = withFailedTries ? await this.d.store.attemptsFor(key) : [];
    for (const a of lane)
      if (
        a.releaseId === release.id &&
        (a.phase === "failed" || a.phase === "lost") &&
        a.provider
      )
        providers.push(a.provider);
    const base = [
      ...new Set(providers.filter((p): p is string => Boolean(p))),
    ].slice(0, MAX_EXCLUDED_PROVIDERS);
    if (!withFailedTries) return { providers: base, remembered: [] };
    const admitted =
      w.kind === "app"
        ? (this.d.config.appProviders ?? []).slice(0, MAX_ALLOWED_PROVIDERS)
        : [];
    const remembered = this.rememberedStrikes(lane, base, admitted).slice(
      0,
      MAX_EXCLUDED_PROVIDERS - base.length
    );
    return { providers: [...base, ...remembered], remembered };
  }

  /**
   * LANE_MEMORY (story.5137): a provider that bound a lease on THIS lane (node + env + workload) and was
   * struck `proof_timeout` or `host_not_routed` at least `STRIKE_MEMORY_MIN` times in the last
   * `STRIKE_MEMORY_MS`, across releases, is excluded from a new create. Without it every release re-tries
   * the same dead provider (candidate-a 2026-11-05: one provider burned 10 minutes of proof_timeout on
   * every release). It reads the attempts store: a struck attempt keeps its provider and its error.
   * NO LOCKOUT: a `proof_timeout` can be the app's own fault, so memory never names
   *  - the lane's most recent served provider (newest active, retiring, retired or lost attempt: blue, or
   *    the blue a stop-then-start just retired), so HAIRPIN_RULE and STOP_THEN_START alone decide blue;
   *  - any provider that served this lane (same phases) in the window;
   *  - the last admitted provider (`appProviders`) not already excluded: memory alone never empties an
   *    admitted pool. With no allowlist the open market is the pool; memory cannot see bids, so that case
   *    rests on the two rules above.
   * Entries already excluded are not repeated; the caller caps the total at the wire's 16.
   */
  private rememberedStrikes(
    lane: readonly AttemptRow[],
    already: readonly string[],
    admitted: readonly string[]
  ): string[] {
    const since = this.d.clock.now() - STRIKE_MEMORY_MS;
    const servedPhase = (a: AttemptRow) => SERVED_PHASES.includes(a.phase);
    const served = new Set<string>();
    const newestServed = lane.find(servedPhase)?.provider;
    if (newestServed) served.add(newestServed);
    for (const a of lane)
      if (a.provider && servedPhase(a) && a.updatedAt.getTime() >= since)
        served.add(a.provider);
    const counts = new Map<string, number>();
    for (const a of lane)
      if (
        a.provider &&
        a.updatedAt.getTime() >= since &&
        STRIKE_MEMORY_ERROR.test(a.error ?? "")
      )
        counts.set(a.provider, (counts.get(a.provider) ?? 0) + 1);
    const open = new Set(admitted.filter((p) => !already.includes(p)));
    const out: string[] = [];
    for (const [p, n] of counts) {
      if (n < STRIKE_MEMORY_MIN || served.has(p) || already.includes(p))
        continue;
      if (open.has(p)) {
        if (open.size === 1) continue; // the last admitted candidate stays open
        open.delete(p);
      }
      out.push(p);
    }
    return out;
  }

  /** New effects use current fleet authority; recorded hosts are never retargeted. */
  private async assertNewAppHost(
    key: WorkloadKey,
    release: ReleaseRow
  ): Promise<void> {
    const w = release.spec;
    const host = publicHostOf(w);
    if (!host) return;
    const edge = this.d.edge;
    if (!edge)
      throw new Error(this.d.httpAdmissionRefusal ?? "edge_not_configured");
    try {
      edge.assertHost(host);
      if (this.d.runtime) {
        const owner = await this.d.runtime.catalog.entryFor(key.nodeId);
        const worker = w.runtimeProfile === "worker" ? w.name : undefined;
        if (
          !owner ||
          !isFleetOwnedRow(owner.row, edge.binding.fleetOwner) ||
          !hostOwnedBy(edge.binding, host, key.env, owner.slug, worker)
        )
          throw new Error(
            `${host} is not the host node ${owner?.slug ?? key.nodeId} may claim in ${key.env}`
          );
        const catalogSlugs = await this.d.runtime.catalog.slugs();
        const refusal =
          worker === undefined
            ? undefined
            : workerHostRefusal({
                binding: edge.binding,
                host,
                env: key.env,
                slug: owner.slug,
                workload: worker,
                catalogSlugs,
              });
        if (refusal) throw new Error(refusal);
        for (const other of catalogSlugs) {
          if (other === owner.slug) continue;
          for (const env of HOST_ENVS)
            if (hostOwnedBy(edge.binding, host, env, other))
              throw new Error(`${host} belongs to node ${other}`);
        }
      }
    } catch (error) {
      throw new Error(`edge_host_refused: ${errText(error)}`);
    }
    await edge.assertZoneIdentity();
    // Reuse the existing by-name read: protected or ambiguous native records refuse before payment.
    await edge.current(host);
  }

  private async doCreate(
    key: WorkloadKey,
    release: ReleaseRow,
    attempt: AttemptRow,
    blue: AttemptRow | undefined
  ): Promise<AttemptRow> {
    const w = release.spec;
    if (release.admissionRefusal)
      return this.failAttempt(
        key,
        release,
        attempt,
        release.admissionRefusal.reason,
        { createEnded: true }
      );

    let runtime: ResolvedRuntime;
    try {
      await this.assertNewAppHost(key, release);
      runtime = await this.resolveEnv(key, release);
    } catch (error) {
      return this.failAttempt(key, release, attempt, errText(error), {
        createEnded: true,
      });
    }

    const { providers: excludeProviders, remembered } = await this.exclusion(
      key,
      release,
      blue,
      true
    );
    if (excludeProviders.length > 0)
      await this.emit(key, release, attempt, "providers_excluded", "ok", {
        providers: excludeProviders,
        remembered,
        reason:
          excludeProviders.join(",") +
          (remembered.length > 0 ? ` (memory: ${remembered.join(",")})` : ""),
      });
    // Placement for APPS only: the interim egress-admitted provider set and the node's catalog
    // country policy. A state workload is never constrained by either.
    const allowProviders =
      w.kind === "app"
        ? (this.d.config.appProviders ?? []).slice(0, MAX_ALLOWED_PROVIDERS)
        : [];
    const requiredCountryCodes =
      w.kind === "app" ? runtime.requiredCountryCodes : [];
    if (allowProviders.length > 0 || requiredCountryCodes.length > 0)
      await this.emit(key, release, attempt, "placement_constrained", "ok", {
        providers: allowProviders,
        reason: `allow=${allowProviders.length} countries=${requiredCountryCodes.join(",") || "none"}`,
      });
    // Durable before native IO: runner loss cannot make a paid call look never-paid.
    attempt = await this.d.store.updateAttempt(attempt.id, {
      error: `ambiguous: dispatch@${this.d.clock.now()}`,
    });
    try {
      const resource = await this.d.payer.create({
        cogniKey: attempt.cogniKey,
        environment: release.env,
        identity: buildIdentity({
          nodeId: key.nodeId,
          releaseId: release.id,
          attempt: attempt.attempt,
        }),
        spec: toPayerSpec(w, runtime.env, {
          requiredCountryCodes,
          nodeApp: runtime.nodeApp,
          companionEnvs: runtime.companionEnvs,
        }),
        ...(excludeProviders.length > 0 ? { excludeProviders } : {}),
        ...(allowProviders.length > 0 ? { allowProviders } : {}),
      });
      return this.bindLease(key, release, attempt, resource);
    } catch (error) {
      if (error instanceof PayerError) {
        if (error.code === "wallet_allocation_blocked") {
          // The slot was busy and this key claimed nothing: safe to try again on the next tick,
          // until the attempt is older than a lease is allowed to take.
          if (
            this.d.clock.now() - attempt.createdAt.getTime() <
            this.d.config.leaseReadyMs
          ) {
            await this.emit(key, release, attempt, "create", "wallet_busy");
            return this.d.store.updateAttempt(attempt.id, {
              error: "unpaid: wallet_busy",
            });
          }
          attempt = await this.d.store.updateAttempt(attempt.id, {
            error: "unpaid: wallet_busy",
          });
          return this.failAttempt(key, release, attempt, "wallet_busy_timeout");
        }
        if (error.ambiguous) {
          const marked = await this.d.store.updateAttempt(attempt.id, {
            // A transport-level failure stamps WHEN it happened: the in-flight grace window is anchored
            // to that moment, not to the (possibly much older) attempt row.
            error: ambiguousMarker(error.code, this.d.clock.now()),
          });
          await this.emit(key, release, marked, "create", "ambiguous", {
            code: error.code,
          });
          // Resolve now; on a failed read the marker makes the next tick resolve first.
          await this.drive(key, release, marked, blue);
          return (
            (await this.d.store.attemptsFor(key)).find(
              (a) => a.id === marked.id
            ) ?? marked
          );
        }
        return this.refuseCreate(
          key,
          release,
          attempt,
          `${error.code}: ${error.message}`,
          error.definitive
        );
      }
      // Any other throw from create is also never replayed under this key (observe guards orphans).
      return this.refuseCreate(key, release, attempt, errText(error));
    }
  }

  /**
   * Persist the refusal BEFORE failAttempt, so a deferred failAttempt is never followed by a replay.
   * Every refusal then runs the ONE cleanup chain (ORPHAN_GUARD in failAttempt): observe by key, a found
   * lease is bound, closed and confirmed, nothing found is `failed`. The payer's observe is also what
   * settles or releases the actuator's receipt, so skipping it would strand the wallet slot or leave a
   * phantom `allocated` record (bug.5569). DEFINITIVE_REFUSAL: `definitive` only proves the create is no
   * longer in flight, so the in-flight grace is skipped; the chain itself is never skipped.
   */
  private async refuseCreate(
    key: WorkloadKey,
    release: ReleaseRow,
    attempt: AttemptRow,
    text: string,
    definitive = false
  ): Promise<AttemptRow> {
    // The native bounded excluded-bidder summary precedes diagnostic text and survives this cap.
    const error = `${REFUSED_PREFIX}${text}`.slice(0, ERROR_TEXT_MAX);
    const refused = await this.d.store.updateAttempt(attempt.id, { error });
    return this.failAttempt(key, release, refused, refused.error ?? "", {
      createEnded: definitive,
    });
  }

  /**
   * An unbound attempt's `observe` threw. Wait, but only `observeUnavailableMs` since the FIRST failure
   * (kept in `unhealthySince`, which has no other meaning on an attempt that never bound a lease). Past
   * the bound the attempt is failed `orphan_suspect:` and alerted, unblocking the release. We never claim
   * the lease is closed: the key may still own one, and the alert names it for a human.
   */
  private async observeUnavailable(
    key: WorkloadKey,
    release: ReleaseRow,
    attempt: AttemptRow,
    step: string,
    context: string,
    error: unknown
  ): Promise<AttemptRow> {
    const now = this.d.clock.now();
    const since = attempt.unhealthySince;
    if (!since) {
      const marked = await this.d.store.updateAttempt(attempt.id, {
        unhealthySince: new Date(now),
      });
      await this.emit(key, release, marked, step, "observe_unavailable", {
        error: errText(error),
      });
      return marked;
    }
    if (now - since.getTime() < this.d.config.observeUnavailableMs) {
      await this.emit(key, release, attempt, step, "observe_unavailable", {
        error: errText(error),
      });
      return attempt;
    }
    // A refused create is not an orphan (bug.5567): it keeps its plain `create refused:` reason, so the
    // no-replay rail and the refusal reading (task.5409) still see it. The alert below still fires.
    const reason = (
      context.startsWith(REFUSED_PREFIX)
        ? `${context}; observe unavailable since ${since.toISOString()}: ${errText(error)}`
        : `orphan_suspect: ${context}; observe unavailable since ${since.toISOString()}: ${errText(error)}`
    ).slice(0, ERROR_TEXT_MAX);
    const failed = await this.d.store.updateAttempt(attempt.id, {
      phase: "failed",
      error: reason,
      unhealthySince: null,
    });
    await this.emit(key, release, failed, "attempt_failed", "failed", {
      reason,
    });
    await this.alert(key, release, failed, "orphan_suspect", {
      reason,
      cogniKey: failed.cogniKey,
    });
    return failed;
  }

  /**
   * A dispatched or unmarked legacy create may still be working. The window starts at dispatch or
   * transport failure; an unstamped marker or legacy planned row uses its creation time.
   */
  private createMayStillBeInFlight(attempt: AttemptRow): boolean {
    if (attempt.externalName) return false;
    const failedAt =
      networkFailureAt(attempt) ??
      (attempt.phase === "planned" && !attempt.error
        ? attempt.createdAt.getTime()
        : undefined);
    return (
      failedAt !== undefined &&
      this.d.clock.now() - failedAt < this.d.config.inflightGraceMs
    );
  }

  /** The grace-window logs repeat every tick, so they are written once per 60 s per attempt and kind. */
  private emitGrace(
    key: WorkloadKey,
    release: ReleaseRow,
    attempt: AttemptRow,
    step: string,
    outcome: string,
    extra: Record<string, unknown>
  ): Promise<void> {
    const now = this.d.clock.now();
    const k = `${attempt.id}/${step}/${outcome}`;
    const last = this.lastGraceLogAt.get(k);
    if (last !== undefined && now - last < GRACE_LOG_THROTTLE_MS)
      return Promise.resolve();
    this.lastGraceLogAt.set(k, now);
    return this.emit(key, release, attempt, step, outcome, extra);
  }

  private async bindLease(
    key: WorkloadKey,
    release: ReleaseRow,
    attempt: AttemptRow,
    resource: {
      externalName: string;
      endpoints: readonly string[];
      providerAccount: string | undefined;
    }
  ): Promise<AttemptRow> {
    const patch: AttemptPatch = {
      phase: "created",
      externalName: resource.externalName,
      endpoints: resource.endpoints,
      error: null,
      // An observe-unavailable clock (unbound attempt) must not read as an unhealthy-lease clock.
      unhealthySince: null,
      leasedAt: new Date(this.d.clock.now()),
      ...(resource.providerAccount
        ? { provider: resource.providerAccount }
        : {}),
    };
    const next = await this.d.store.updateAttempt(attempt.id, patch);
    await this.emit(key, release, next, "created", "ok", {
      dseq: resource.externalName,
      provider: resource.providerAccount,
    });
    return next;
  }

  // ---- lease ready ----------------------------------------------------------------------------

  private async awaitLease(
    key: WorkloadKey,
    release: ReleaseRow,
    attempt: AttemptRow,
    blue: AttemptRow | undefined
  ): Promise<AttemptRow> {
    const w = release.spec;
    const host = publicHostOf(w);
    let a = attempt;
    const leasedAt = (a.leasedAt ?? a.createdAt).getTime();
    for (;;) {
      let obs: Awaited<ReturnType<PayerPort["observe"]>>;
      try {
        obs = await this.d.payer.observe({
          cogniKey: a.cogniKey,
          ...(a.externalName ? { externalName: a.externalName } : {}),
        });
      } catch (error) {
        await this.emit(key, release, a, "lease_ready", "observe_error", {
          error: errText(error),
        });
        obs = { found: true };
      }
      const r = obs.resource;
      if (obs.found === false || r?.state === "closed")
        return this.failAttempt(key, release, a, "lease_closed_before_ready");
      if (r) {
        if (
          blue?.provider &&
          r.providerAccount &&
          r.providerAccount === blue.provider
        ) {
          // NOT_BLUES_PROVIDER: two leases on one provider ingress cannot both claim one host.
          await this.strike(key, release, a, "same_provider_as_blue");
          return this.failAttempt(key, release, a, "same_provider_as_blue");
        }
        const usable =
          w.kind === "app"
            ? ingressHostOf(r.endpoints, host) !== undefined
            : tryForwarded(r.endpoints);
        if (r.state === "active" && usable) {
          a = await this.d.store.updateAttempt(a.id, {
            phase: "proving",
            endpoints: r.endpoints,
            ...(r.providerAccount ? { provider: r.providerAccount } : {}),
          });
          await this.emit(key, release, a, "lease_active", "ok", {
            endpoints: r.endpoints,
            provider: r.providerAccount,
          });
          return a;
        }
      }
      if (this.d.clock.now() - leasedAt >= this.d.config.leaseReadyMs)
        return this.failAttempt(key, release, a, "lease_not_ready");
      await this.d.clock.sleep(this.d.config.pollMs);
    }
  }

  // ---- prove ----------------------------------------------------------------------------------

  private async prove(
    key: WorkloadKey,
    release: ReleaseRow,
    attempt: AttemptRow
  ): Promise<AttemptRow> {
    const w = release.spec;
    const host = publicHostOf(w);
    const deadline =
      (attempt.leasedAt ?? attempt.createdAt).getTime() + this.d.config.proofMs;
    let last = "no probe yet";
    let lastNote = this.d.clock.now();
    // HOST_NOT_ROUTED: start of an unbroken run of `/version` 404s from the provider ingress.
    let notRoutedSince: number | undefined;
    for (;;) {
      if (w.kind === "app") {
        const ingress = ingressHostOf(attempt.endpoints, host);
        const health = w.health;
        if (ingress && host && health) {
          const v = await this.d.probe.hostRouted(
            ingress,
            host,
            health.version
          );
          notRoutedSince =
            v.status === 404
              ? (notRoutedSince ?? this.d.clock.now())
              : undefined;
          if (v.status === 200 && buildShaOf(v.body) === release.sourceSha) {
            const r = await this.d.probe.hostRouted(
              ingress,
              host,
              health.ready
            );
            if (r.status === 200) {
              try {
                attempt = await this.qualify(release, attempt, "qualify");
              } catch (error) {
                await this.qualificationDiagnostic(
                  key,
                  release,
                  attempt,
                  "qualify",
                  error
                );
                return this.failAttempt(
                  key,
                  release,
                  attempt,
                  "qualification_failed"
                );
              }
              const next = await this.d.store.updateAttempt(attempt.id, {
                phase: "proven",
              });
              await this.emit(key, release, next, "proven", "ok", {
                ingress,
                version: release.sourceSha,
                readyz: r.status,
              });
              return next;
            }
            last = `readyz ${r.status} ${r.error ?? r.body.slice(0, 80)}`;
          } else {
            last = `version ${v.status} sha=${buildShaOf(v.body) ?? "none"} ${v.error ?? ""}`;
          }
        }
      } else {
        const t = tryForwarded(attempt.endpoints);
        if (t && (await this.d.probe.tcpTls(t.host, t.port))) {
          const next = await this.d.store.updateAttempt(attempt.id, {
            phase: "proven",
          });
          await this.emit(key, release, next, "proven", "ok", {
            endpoint: `${t.host}:${t.port}`,
          });
          return next;
        }
        last = "tcp tls handshake not answered";
      }
      // A closed lease cannot become healthy: stop waiting.
      const closed = await this.isClosed(attempt);
      if (closed)
        return this.failAttempt(
          key,
          release,
          attempt,
          "lease_closed_while_proving"
        );
      if (
        notRoutedSince !== undefined &&
        this.d.clock.now() - notRoutedSince >= this.d.config.hostNotRoutedMs
      ) {
        // The provider ingress does not route our host: it can never pass. Close green through the
        // normal path (blue and the edge are untouched); its provider is excluded for this release.
        await this.strike(key, release, attempt, "host_not_routed");
        return this.failAttempt(
          key,
          release,
          attempt,
          `host_not_routed: ${last.trim()} for ${Math.round((this.d.clock.now() - notRoutedSince) / 1000)}s`
        );
      }
      if (this.d.clock.now() >= deadline) {
        await this.strike(key, release, attempt, "proof_timeout");
        return this.failAttempt(
          key,
          release,
          attempt,
          `proof_timeout: ${last}`
        );
      }
      if (this.d.clock.now() - lastNote >= 60_000) {
        lastNote = this.d.clock.now();
        await this.emit(key, release, attempt, "proving", "waiting", { last });
      }
      await this.d.clock.sleep(this.d.config.pollMs);
    }
  }

  // ---- cutover --------------------------------------------------------------------------------

  private async cutover(
    key: WorkloadKey,
    release: ReleaseRow,
    attempt: AttemptRow,
    blue: AttemptRow | undefined
  ): Promise<void> {
    const w = release.spec;
    const host = publicHostOf(w);
    if (w.kind === "app" && host) {
      const edge = this.d.edge;
      const ingress = ingressHostOf(attempt.endpoints, host);
      if (!edge || !ingress) {
        await this.failAttempt(key, release, attempt, "edge_not_configured");
        return;
      }
      let touched = false;
      try {
        await this.qualify(release, attempt, "readback");
        const rec = await edge.point(host, ingress);
        touched = true;
        await this.emit(key, release, attempt, "edge_moved", "ok", {
          record: rec.id,
          target: rec.content,
        });
        const firstAt = await this.awaitPublic(
          host,
          release.sourceSha,
          w.health?.version ?? "/version",
          {
            nodeId: key.nodeId,
            env: key.env,
            workload: key.workload,
            releaseId: release.id,
            attempt: attempt.id,
          }
        );
        await this.emit(key, release, attempt, "public_readback", "ok", {
          host,
          consecutive: this.d.config.publicStreak,
          firstAt,
        });
      } catch (error) {
        if (!touched && error instanceof QualificationFailure)
          await this.qualificationDiagnostic(
            key,
            release,
            attempt,
            "readback",
            error
          );
        // Restore the edge to blue when we moved it (a re-point, NOT a withdrawal), then close green.
        const blueIngress = blue
          ? ingressHostOf(blue.endpoints, host)
          : undefined;
        if (touched && blueIngress) {
          await edge
            .point(host, blueIngress)
            .then(() =>
              this.emit(key, release, attempt, "edge_restored", "ok", {
                target: blueIngress,
              })
            )
            .catch((e: unknown) =>
              this.alert(key, release, attempt, "edge_restore_failed", {
                error: errText(e),
              })
            );
        }
        await this.failAttempt(
          key,
          release,
          attempt,
          `cutover_failed: ${errText(error)}`
        );
        return;
      }
    }

    const active = await this.d.store.updateAttempt(attempt.id, {
      phase: "active",
      unhealthySince: null,
    });
    await this.emit(key, release, active, "activated", "ok", {
      dseq: active.externalName,
      // Lead time: intent recorded -> serving. The Grafana lead-time panel unwraps this field.
      leadTimeMs: Math.max(0, this.d.clock.now() - release.createdAt.getTime()),
    });
    if (blue && blue.id !== active.id && blue.phase === "active") {
      const retiring = await this.d.store.updateAttempt(blue.id, {
        phase: "retiring",
      });
      await this.emit(key, release, retiring, "blue_retiring", "ok", {
        dseq: retiring.externalName,
        retainMs: this.d.config.retainMs,
      });
    }
  }

  /** Persist before proven; read the current subject again before any edge mutation. */
  private async qualify(
    release: ReleaseRow,
    attempt: AttemptRow,
    mode: "qualify" | "readback"
  ): Promise<AttemptRow> {
    const capability = release.spec.health?.qualification;
    if (!capability)
      return this.qualifyWithin(release, attempt, mode, () => false);
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new QualificationFailure("deadline", "expired"));
      }, capability.timeoutMs);
    });
    try {
      return await Promise.race([
        this.qualifyWithin(release, attempt, mode, () => expired),
        deadline,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async qualifyWithin(
    release: ReleaseRow,
    attempt: AttemptRow,
    mode: "qualify" | "readback",
    expired: () => boolean
  ): Promise<AttemptRow> {
    const capability = release.spec.health?.qualification;
    if (!capability) {
      if (release.spec.companions?.length)
        throw new QualificationFailure("precondition", "capability_missing");
      return attempt;
    }
    const startedAt = this.d.clock.now();
    const deadline = startedAt + capability.timeoutMs;
    const ingress = ingressHostOf(
      attempt.endpoints,
      publicHostOf(release.spec)
    );
    const host = publicHostOf(release.spec);
    const post = this.d.probe.qualification?.bind(this.d.probe);
    if (!ingress || !host || !post)
      throw new QualificationFailure("precondition", "transport_missing");
    const current = (await this.d.store.attemptsFor(release)).find(
      (a) => a.id === attempt.id
    );
    if (!current || current.externalName !== attempt.externalName)
      throw new QualificationFailure("precondition", "attempt_changed");
    const prior = savedQualification(current);
    if (mode === "qualify" && prior)
      return this.qualifyWithin(release, current, "readback", expired);
    if (mode === "readback" && !prior)
      throw new QualificationFailure("precondition", "evidence_missing");
    if (
      mode === "qualify" &&
      current.steps.some((s) => s.step === "qualification_started")
    )
      throw new QualificationFailure("reserve", "already_reserved");
    const runtime = await this.nodeAppRuntime(release, release);
    const authSecret = runtime?.env.AUTH_SECRET;
    if (!authSecret)
      throw new QualificationFailure("precondition", "auth_unavailable");
    if (expired() || this.d.clock.now() >= deadline)
      throw new QualificationFailure("deadline", "expired");
    const challenge = await qualificationChallenge({
      release,
      attempt: current,
      authSecret,
      now: this.d.clock.now(),
      mode,
      ...(prior ? { prior } : {}),
    });
    if (mode === "qualify") {
      // This is a required durable write, not best-effort telemetry. A lost write response never dispatches.
      try {
        await this.emit(
          release,
          release,
          current,
          "qualification_started",
          "reserved",
          {},
          true
        );
      } catch {
        throw new QualificationFailure("reserve", "write_failed");
      }
      const reserved = (await this.d.store.attemptsFor(release)).find(
        (a) => a.id === current.id
      );
      if (!reserved?.steps.some((s) => s.step === "qualification_started"))
        throw new QualificationFailure("reserve", "not_persisted");
    }
    const remaining = deadline - this.d.clock.now();
    if (expired() || remaining <= 0)
      throw new QualificationFailure("deadline", "expired");
    // ONE_AUTHORITY (bug.5568): the static ingress is Host and SNI; the port takes no other host.
    const result = await post({
      ingressHost: ingress,
      path: capability.path,
      token: challenge.token,
      mode,
      timeoutMs: remaining,
    });
    const sent = { ms: result.ms };
    if (result.status === 0)
      throw new QualificationFailure(
        "transport",
        result.error ?? "transport_failed",
        sent
      );
    if (result.status < 200 || result.status >= 300)
      throw new QualificationFailure("http", "status", {
        ...sent,
        status: result.status,
      });
    if (expired() || this.d.clock.now() > deadline)
      throw new QualificationFailure("deadline", "expired", {
        ...sent,
        status: result.status,
      });
    let evidence: ReturnType<typeof checkQualification>;
    try {
      evidence = checkQualification({
        body: result.body,
        release,
        attempt: current,
        nonce: challenge.nonce,
        startedAt,
        now: this.d.clock.now(),
        ...(prior ? { prior } : {}),
      });
    } catch (error) {
      throw new QualificationFailure("validate", validationCode(error), {
        ...sent,
        status: result.status,
      });
    }
    const step = {
      step: mode === "qualify" ? "qualification" : "qualification_readback",
      outcome: "ok",
      reason: JSON.stringify(evidence),
      at: new Date(this.d.clock.now()).toISOString(),
    };
    try {
      await this.emit(
        release,
        release,
        current,
        step.step,
        step.outcome,
        { reason: step.reason },
        true
      );
    } catch {
      throw new QualificationFailure("persist", "write_failed");
    }
    const saved = (await this.d.store.attemptsFor(release)).find(
      (a) => a.id === current.id
    );
    if (
      !saved ||
      saved.externalName !== current.externalName ||
      JSON.stringify(saved.endpoints) !== JSON.stringify(current.endpoints) ||
      !saved.steps.some((s) => s.step === step.step && s.reason === step.reason)
    )
      throw new QualificationFailure("persist", "not_persisted");
    return saved;
  }

  /**
   * BOUNDED_DIAGNOSTIC (bug.5568): one correlated event for a failed qualification or readback. It
   * carries mode, stage, allowlisted code, HTTP status, elapsed time, attempt, allocation and the
   * ingress used as Host and SNI. Never the bearer, headers, body or a raw error. Best-effort: it does
   * not change the failure and cleanup decision that follows.
   */
  private async qualificationDiagnostic(
    key: WorkloadKey,
    release: ReleaseRow,
    attempt: AttemptRow,
    mode: "qualify" | "readback",
    error: unknown
  ): Promise<void> {
    const f = asQualificationFailure(error);
    const ingress = ingressHostOf(
      attempt.endpoints,
      publicHostOf(release.spec)
    );
    try {
      await this.emit(
        key,
        release,
        attempt,
        "qualification_diagnostic",
        f.stage,
        {
          reason: `${mode} ${f.message}`,
          mode,
          stage: f.stage,
          code: f.code,
          ...(f.status === undefined ? {} : { httpStatus: f.status }),
          ...(f.ms === undefined ? {} : { qualificationMs: f.ms }),
          attemptId: attempt.id,
          allocation: attempt.externalName,
          ...(ingress ? { ingress, host: ingress } : {}),
        }
      );
    } catch {
      // Telemetry never changes the verdict.
    }
  }

  /** Poll the PUBLIC host until `publicStreak` consecutive reads return the exact sha. */
  private async awaitPublic(
    host: string,
    sha: string,
    versionPath: string,
    fields: Record<string, unknown>
  ): Promise<string> {
    const { clock, probe, config } = this.d;
    const deadline = clock.now() + config.publicMs;
    let streak = 0;
    let firstAt = "";
    let last = "";
    let fallbackLogged = false;
    for (;;) {
      const v = await probe.publicRead(
        host,
        `${versionPath}?cb=${clock.now()}`
      );
      // Once per host per release: the authoritative path failed and this read used DoH.
      if (v.fallback && !fallbackLogged) {
        fallbackLogged = true;
        this.d.log.warn(
          {
            component: "node-deploy-sequencer",
            ...fields,
            host,
            reason: v.fallback,
          },
          "node_deploy_public_read_fallback"
        );
      }
      if (v.status === 200 && buildShaOf(v.body) === sha) {
        if (streak === 0) firstAt = new Date(clock.now()).toISOString();
        streak++;
        if (streak >= config.publicStreak) return firstAt;
        await clock.sleep(1_000);
        continue;
      }
      streak = 0;
      last = `${v.status} ${v.error ?? v.body.slice(0, 80)}`;
      if (clock.now() >= deadline)
        throw new Error(
          `public host ${host} never served ${sha} for ${config.publicStreak} consecutive reads (last ${last})`
        );
      await clock.sleep(1_500);
    }
  }

  // ---- failure / close ------------------------------------------------------------------------

  /**
   * Mark failed (counting toward the park), close the lease if one exists, confirm it.
   * `createEnded` (bug.5569): the payer proved the create is no longer in flight (a definitive
   * refusal), so the in-flight grace is skipped. The observe and close below still run.
   */
  private async failAttempt(
    key: WorkloadKey,
    release: ReleaseRow,
    attempt: AttemptRow,
    reason: string,
    opts: { createEnded?: boolean } = {}
  ): Promise<AttemptRow> {
    const trimmed = reason.slice(0, ERROR_TEXT_MAX);
    // ORPHAN_GUARD (CD8): an attempt with no bound handle may still own a PAID lease (the create
    // succeeded and its response was lost, or we crashed before binding). Ask the payer by key BEFORE
    // writing any terminal state. A lease that exists is bound and then closed + confirmed; if the
    // question cannot be answered the attempt is left exactly as it is and retried on the next tick.
    if (!attempt.externalName) {
      if (!opts.createEnded && this.createMayStillBeInFlight(attempt)) {
        // Never fail/supersede (and never observe) while the actuator may still be creating.
        await this.emitGrace(
          key,
          release,
          attempt,
          "attempt_failed",
          "deferred",
          {
            reason: trimmed,
            inflightGraceMs: this.d.config.inflightGraceMs,
          }
        );
        return attempt;
      }
      let obs: Awaited<ReturnType<PayerPort["observe"]>>;
      try {
        obs = await this.d.payer.observe({ cogniKey: attempt.cogniKey });
      } catch (error) {
        await this.emit(key, release, attempt, "attempt_failed", "deferred", {
          reason: trimmed,
          observeError: errText(error),
        });
        return this.observeUnavailable(
          key,
          release,
          attempt,
          "attempt_failed",
          trimmed,
          error
        );
      }
      if (obs.found && obs.resource) {
        const bound = await this.d.store.updateAttempt(attempt.id, {
          unhealthySince: null,
          externalName: obs.resource.externalName,
          endpoints: obs.resource.endpoints,
          ...(obs.resource.providerAccount
            ? { provider: obs.resource.providerAccount }
            : {}),
        });
        await this.emit(
          key,
          release,
          bound,
          "orphan_lease",
          "adopted_to_close",
          {
            dseq: bound.externalName,
          }
        );
        return this.failAttempt(key, release, bound, trimmed);
      }
      const next = await this.d.store.updateAttempt(attempt.id, {
        phase: "failed",
        error: trimmed,
        unhealthySince: null,
      });
      await this.emit(key, release, next, "attempt_failed", "failed", {
        reason: trimmed,
      });
      return next;
    }
    const closing = await this.d.store.updateAttempt(attempt.id, {
      phase: "closing",
      error: trimmed,
    });
    await this.emit(key, release, closing, "attempt_failed", "closing", {
      reason: trimmed,
      dseq: closing.externalName,
    });
    const confirmed = await this.closeAndConfirm(closing);
    if (!confirmed) {
      await this.alert(key, release, closing, "close_unconfirmed", {
        reason: trimmed,
      });
      return closing;
    }
    const failed = await this.d.store.updateAttempt(attempt.id, {
      phase: "failed",
    });
    await this.emit(key, release, failed, "new_closed", "ok", {
      dseq: failed.externalName,
    });
    return failed;
  }

  /** delete, then require observe AND chain truth (when wired) to say closed. */
  private async closeAndConfirm(a: AttemptRow): Promise<boolean> {
    if (!a.externalName) return true;
    try {
      await this.d.payer.delete({
        cogniKey: a.cogniKey,
        externalName: a.externalName,
      });
    } catch (error) {
      if (!(error instanceof PayerError && error.code === "not_found")) {
        this.d.log.warn(
          {
            component: "node-deploy-sequencer",
            cogniKey: a.cogniKey,
            dseq: a.externalName,
            error: errText(error),
          },
          "node_deploy_close_delete_failed"
        );
      }
    }
    const deadline = this.d.clock.now() + this.d.config.closeConfirmMs;
    for (;;) {
      if (await this.isClosed(a, true)) return true;
      if (this.d.clock.now() >= deadline) return false;
      await this.d.clock.sleep(this.d.config.pollMs);
    }
  }

  /** observe says closed (or unknown handle) AND, when `strict`, chain truth agrees. */
  private async isClosed(a: AttemptRow, strict = false): Promise<boolean> {
    if (!a.externalName) return true;
    let closedByObserve = false;
    try {
      const obs = await this.d.payer.observe({
        cogniKey: a.cogniKey,
        externalName: a.externalName,
      });
      closedByObserve = obs.found === false || obs.resource?.state === "closed";
    } catch {
      return false;
    }
    if (!closedByObserve) return false;
    if (!strict || !this.d.chain) return true;
    try {
      const truth = await this.d.chain.deploymentState(a.externalName);
      return truth === "closed" || truth === "insufficient_funds";
    } catch {
      return false;
    }
  }

  // ---- janitor: retention + unconfirmed closes ------------------------------------------------

  private async janitor(key: WorkloadKey): Promise<void> {
    const all = await this.d.store.attemptsFor(key);
    for (const a of all) {
      if (a.phase === "retiring") {
        const age = this.d.clock.now() - a.updatedAt.getTime();
        if (age < this.d.config.retainMs) continue;
        const release = await this.d.store.getRelease(a.releaseId);
        if (await this.closeAndConfirm(a)) {
          const retired = await this.d.store.updateAttempt(a.id, {
            phase: "retired",
          });
          if (release)
            await this.emit(key, release, retired, "old_closed", "ok", {
              dseq: retired.externalName,
              verified: true,
            });
        } else if (
          release &&
          age >= this.d.config.retainMs + this.d.config.closeAlertMs
        ) {
          await this.alert(key, release, a, "close_unconfirmed");
        }
      } else if (a.phase === "closing") {
        const release = await this.d.store.getRelease(a.releaseId);
        if (await this.closeAndConfirm(a)) {
          const failed = await this.d.store.updateAttempt(a.id, {
            phase: "failed",
          });
          if (release)
            await this.emit(key, release, failed, "new_closed", "ok", {
              dseq: failed.externalName,
              verified: true,
            });
        } else if (release) {
          await this.alert(key, release, a, "close_unconfirmed");
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // reconcile: detect a LOST lease and let `step` redeploy it
  // -------------------------------------------------------------------------------------------

  async reconcile(key: WorkloadKey): Promise<ReconcileOutcome> {
    return (
      (await this.exclusive(key, () => this.reconcileLocked(key))) ?? "busy"
    );
  }

  private async reconcileLocked(key: WorkloadKey): Promise<ReconcileOutcome> {
    if (key.env !== this.d.config.environment) return "none";
    const desired = await this.d.store.getDesired(key);
    if (!desired || desired.state !== "running") return "none";
    const all = await this.d.store.attemptsFor(key);
    const active = all.find((a) => a.phase === "active");
    if (!active?.externalName) return "none";
    const release = await this.d.store.getRelease(active.releaseId);
    if (!release) return "none";

    let lost = false;
    let why = "";
    let observeOk = true;
    try {
      const obs = await this.d.payer.observe({
        cogniKey: active.cogniKey,
        externalName: active.externalName,
      });
      if (!obs.found || obs.resource?.state === "closed") {
        lost = true;
        why = "observe_closed";
      }
    } catch {
      observeOk = false; // a blip is not a loss
    }
    if (!lost && this.d.chain) {
      try {
        const truth = await this.d.chain.deploymentState(active.externalName);
        if (truth === "closed" || truth === "insufficient_funds") {
          lost = true;
          why = `chain_${truth}`;
        }
      } catch {
        /* chain read failure is not a loss */
      }
    }

    if (lost) return this.handleLost(key, release, active, why);

    // Live on chain: a failed proof is only an alert until it has lasted `unhealthyLostMs`.
    if (release.spec.kind === "app" && observeOk) {
      const proof = await this.quickProof(release, active);
      // `error` is null on an active attempt; DEPENDENCY_DOWN_MARK records that the current unhealthy
      // clock was started by (or has run through) a dependency outage, not by a bad lease.
      const wasDependencyDown = active.error === DEPENDENCY_DOWN_MARK;
      if (proof === "healthy") {
        if (active.unhealthySince || wasDependencyDown) {
          await this.d.store.updateAttempt(active.id, {
            unhealthySince: null,
            ...(wasDependencyDown ? { error: null } : {}),
          });
          await this.emit(key, release, active, "unhealthy_cleared", "ok");
        }
        return "healthy";
      }
      if (proof === "lease_bad" && wasDependencyDown) {
        // /version started failing only after a dependency outage: the 15 minutes for a BAD lease
        // start now, so one /version blip can never close a lease the outage kept alive.
        await this.d.store.updateAttempt(active.id, {
          unhealthySince: new Date(this.d.clock.now()),
          error: null,
        });
        await this.alert(key, release, active, "proof_failing", {
          why: "version_failing_after_dependency_down",
        });
        return "unhealthy_waiting";
      }
      if (proof === "dependency_down" && !wasDependencyDown)
        await this.d.store.updateAttempt(active.id, {
          error: DEPENDENCY_DOWN_MARK,
        });
      const since = active.unhealthySince ?? new Date(this.d.clock.now());
      if (!active.unhealthySince) {
        await this.d.store.updateAttempt(active.id, { unhealthySince: since });
        await this.alert(key, release, active, "proof_failing", {});
        return "unhealthy_waiting";
      }
      if (
        this.d.clock.now() - since.getTime() >=
        this.d.config.unhealthyLostMs
      ) {
        if (proof === "dependency_down") {
          // The lease still serves its exact build: a failing /readyz is a dependency outage, and a
          // replacement would hit the same outage. Keep it, alert, never close or redeploy.
          await this.alert(key, release, active, "dependency_down", {
            why: "readyz_failing_version_serving",
          });
          return "unhealthy_waiting";
        }
        // lease_bad: /version fails too. A failing but LIVE lease is closed and confirmed before anything replaces it.
        if (await this.closeAndConfirm(active))
          return this.handleLost(key, release, active, "proof_failed_15m");
        await this.alert(key, release, active, "close_unconfirmed", {
          why: "proof_failed_15m",
        });
        return "unhealthy_waiting";
      }
      return "unhealthy_waiting";
    }
    return "healthy";
  }

  private async handleLost(
    key: WorkloadKey,
    release: ReleaseRow,
    active: AttemptRow,
    why: string
  ): Promise<ReconcileOutcome> {
    const lost = await this.d.store.updateAttempt(active.id, {
      phase: "lost",
      error: why,
    });
    if (release.spec.kind === "state") {
      // STATE_IS_NEVER_AUTO_REPLACED: alert, never recreate.
      await this.alert(key, release, lost, "state_lease_lost", { why });
      return "lost_state_alert";
    }
    await this.emit(key, release, lost, "lease_lost", "lost", { why });
    return "lost_app";
  }

  /**
   * `dependency_down`: the exact build still answers /version but /readyz fails (a dependency outage the
   * lease cannot fix). `lease_bad`: /version itself fails or serves another sha.
   */
  private async quickProof(
    release: ReleaseRow,
    a: AttemptRow
  ): Promise<"healthy" | "dependency_down" | "lease_bad"> {
    const w = release.spec;
    const host = publicHostOf(w);
    const ingress = ingressHostOf(a.endpoints, host);
    if (!host || !ingress || !w.health) return "healthy";
    const v = await this.d.probe.hostRouted(ingress, host, w.health.version);
    if (v.status !== 200 || buildShaOf(v.body) !== release.sourceSha)
      return "lease_bad";
    const r = await this.d.probe.hostRouted(ingress, host, w.health.ready);
    return r.status === 200 ? "healthy" : "dependency_down";
  }

  // -------------------------------------------------------------------------------------------
  // plumbing
  // -------------------------------------------------------------------------------------------

  private async exclusive<T>(
    key: WorkloadKey,
    fn: () => Promise<T>
  ): Promise<T | undefined> {
    const k = keyString(key);
    if (this.running.has(k)) return undefined;
    this.running.add(k);
    try {
      return await fn();
    } finally {
      this.running.delete(k);
    }
  }

  /**
   * THE ONE EMIT HELPER. Every sequencer event — `node_deploy_step`, `node_deploy_provider_strike`,
   * `node_deploy_alert` — is written by `record`, which logs the line AND (when the event belongs to an
   * attempt) appends the same step to that attempt's durable timeline. There is no second code path, so
   * the Loki event and the persisted step cannot drift (task.5400 observability).
   *
   * Persistence is observability only: a failed append is logged `node_deploy_step_persist_failed` and
   * NEVER fails or delays the deploy decision that emitted the step. Qualification receipts use
   * requiredPersistence: their complete bounded subject is saved and a failed write refuses proof. Consecutive identical steps of one
   * attempt (a poll loop) collapse into one persisted row; the log line is still written every time.
   */
  private async record(
    level: "info" | "warn" | "error",
    msg: string,
    attempt: AttemptRow | undefined,
    fields: Record<string, unknown>,
    requiredPersistence = false
  ): Promise<void> {
    const now = this.d.clock.now();
    // `elapsedMs` = time since the attempt row was created: the step-latency series Grafana unwraps.
    const elapsedMs =
      attempt?.createdAt instanceof Date
        ? Math.max(0, now - attempt.createdAt.getTime())
        : undefined;
    this.d.log[level](
      elapsedMs === undefined ? fields : { ...fields, elapsedMs },
      msg
    );
    if (!attempt) return;
    const reason = requiredPersistence
      ? textOf(fields.reason)
      : reasonOf(fields);
    const dseq = textOf(fields.dseq);
    const provider = textOf(fields.provider) ?? attempt.provider;
    const step: AttemptStep = {
      step: String(fields.step),
      outcome: String(fields.outcome),
      ...(reason ? { reason } : {}),
      ...(dseq ? { dseq } : {}),
      ...(provider ? { provider } : {}),
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
      at: new Date(now).toISOString(),
    };
    const signature = `${step.step}|${step.outcome}|${step.reason ?? ""}`;
    if (this.lastStep.get(attempt.id) === signature) return;
    if (this.lastStep.size > 500) this.lastStep.clear();
    this.lastStep.set(attempt.id, signature);
    try {
      await this.d.store.appendAttemptStep(attempt.id, step);
    } catch (error) {
      this.lastStep.delete(attempt.id);
      this.d.log.warn(
        {
          component: "node-deploy-sequencer",
          nodeId: fields.nodeId,
          env: fields.env,
          workload: fields.workload,
          releaseId: fields.releaseId,
          attempt: fields.attempt,
          step: step.step,
          outcome: step.outcome,
          error: errText(error).slice(0, 300),
        },
        "node_deploy_step_persist_failed"
      );
      if (requiredPersistence) throw error;
    }
  }

  private emit(
    key: WorkloadKey,
    release: ReleaseRow | undefined,
    attempt: AttemptRow | undefined,
    step: string,
    outcome: string,
    extra: Record<string, unknown> = {},
    requiredPersistence = false
  ): Promise<void> {
    return this.record(
      "info",
      "node_deploy_step",
      attempt,
      {
        component: "node-deploy-sequencer",
        nodeId: key.nodeId,
        env: key.env,
        workload: key.workload,
        releaseId: release?.id,
        attempt: attempt?.attempt,
        dseq: attempt?.externalName,
        step,
        outcome,
        sourceSha: release?.sourceSha,
        ...extra,
      },
      requiredPersistence
    );
  }

  /**
   * A tick-level failure repeats every tick while its cause persists (a down database, a bad row), so it
   * is throttled per (workload, loop, message) like every other alert. It belongs to no attempt, so it
   * is logged only.
   */
  private loopError(key: WorkloadKey, loop: string, error: unknown): void {
    const message = errText(error).slice(0, 300);
    const throttleKey = `${keyString(key)}/loop:${loop}/${message}`;
    const now = this.d.clock.now();
    const last = this.lastAlertAt.get(throttleKey);
    if (last !== undefined && now - last < ALERT_THROTTLE_MS) return;
    this.lastAlertAt.set(throttleKey, now);
    void this.record("error", "node_deploy_step", undefined, {
      component: "node-deploy-sequencer",
      nodeId: key.nodeId,
      env: key.env,
      workload: key.workload,
      step: loop,
      outcome: "threw",
      error: message,
    });
  }

  /**
   * A provider-attributable failure (it won the auction but could not serve, or landed on blue's
   * provider). The actuator's v1 wire has no way to take a strike or an exclusion from us, so this
   * event is the record: one line per occurrence, never throttled, queryable by message.
   */
  private strike(
    key: WorkloadKey,
    release: ReleaseRow,
    attempt: AttemptRow,
    reason: string
  ): Promise<void> {
    return this.record("warn", "node_deploy_provider_strike", attempt, {
      component: "node-deploy-sequencer",
      nodeId: key.nodeId,
      env: key.env,
      workload: key.workload,
      releaseId: release.id,
      attempt: attempt.attempt,
      dseq: attempt.externalName,
      provider: attempt.provider,
      step: "provider_strike",
      outcome: reason,
      sourceSha: release.sourceSha,
    });
  }

  private alert(
    key: WorkloadKey,
    release: ReleaseRow | undefined,
    attempt: AttemptRow | undefined,
    reason: string,
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    // One alert per (workload, release, reason) per 10 minutes: a parked release is re-evaluated every
    // tick and must not write a line per tick.
    const throttleKey = `${keyString(key)}/${release?.id ?? "-"}/${reason}`;
    const now = this.d.clock.now();
    const last = this.lastAlertAt.get(throttleKey);
    if (last !== undefined && now - last < ALERT_THROTTLE_MS)
      return Promise.resolve();
    this.lastAlertAt.set(throttleKey, now);
    return this.record("error", "node_deploy_alert", attempt, {
      component: "node-deploy-sequencer",
      nodeId: key.nodeId,
      env: key.env,
      workload: key.workload,
      releaseId: release?.id,
      attempt: attempt?.attempt,
      dseq: attempt?.externalName,
      step: "alert",
      outcome: reason,
      sourceSha: release?.sourceSha,
      ...extra,
    });
  }
}

/** Persisted on an attempt whose create was refused, so a re-drive fails it instead of replaying the key. */
const REFUSED_PREFIX = "create refused: ";

/** Max diagnostic text. Native decision evidence is bounded independently and comes first. */
const ERROR_TEXT_MAX = 2000;

/**
 * True when a persisted create refusal shows blue's provider as the only bidder screening could pass
 * (task.5409). The native bounded excluded-bidder summary carries full provider identities before
 * diagnostic text. Legacy fallback keys on the actuator's NO_ELIGIBLE_BIDS text (`akash-compute.adapter.ts`
 * `awaitScreenedBid`: "none passed provider screening [refused: ...] [bids: ...]") and its exclusion
 * verdict `already_tried` (`akash-provider-screen.ts` `rejectionFor`: an excluded provider's bid). When
 * `onlyBlueExcluded`, the caller's exclude list was exactly {blue}, so any `already_tried` bid is blue's;
 * otherwise the roster (`formatBidRoster`: `<addr> <cc> <price> <verdict>`) must name blue's address.
 */
function blueWasOnlyScreenedBidder(
  error: string | undefined,
  blueProvider: string,
  onlyBlueExcluded: boolean
): boolean {
  if (!error?.startsWith(REFUSED_PREFIX)) return false;
  if (!error.includes("none passed provider screening")) return false;
  if (error.includes("[excluded-bidders-v1:")) {
    const encoded = /\[excluded-bidders-v1:(\[[^\]]*\])\]/u.exec(error)?.[1];
    if (!encoded) return false;
    try {
      const providers: unknown = JSON.parse(encoded);
      return (
        Array.isArray(providers) &&
        providers.length <= 16 &&
        providers.every(
          (p: unknown) =>
            typeof p === "string" && /^akash1[0-9a-z]{38}$/u.test(p)
        ) &&
        providers.includes(blueProvider)
      );
    } catch {
      return false;
    }
  }
  const tried = /already_tried=(\d+)/u.exec(error);
  if (!tried?.[1] || Number(tried[1]) < 1) return false;
  if (onlyBlueExcluded) return true;
  const addr =
    blueProvider.length > 17
      ? `${blueProvider.slice(0, 9)}…${blueProvider.slice(-4)}`
      : blueProvider;
  // Legacy fallback needs a complete roster; clipped diagnostics cannot authorize a stop.
  const roster = /\[bids: ([^\]]*)\]/u.exec(error)?.[1] ?? "";
  return roster
    .split(", ")
    .some((r) => r.startsWith(`${addr} `) && r.endsWith(" already_tried"));
}

/** Marker on an ACTIVE attempt (whose `error` is otherwise null): its failing proof is a dependency outage. */
const DEPENDENCY_DOWN_MARK = "dependency_down";

/** `ambiguous: <code>`; a network failure carries the failure time: `ambiguous: network@<epoch ms>`. */
function ambiguousMarker(code: string, now: number): string {
  return code === "network"
    ? `ambiguous: network@${now}`
    : `ambiguous: ${code}`;
}

/** When a create entered native IO or failed in transit (stamp, else legacy createdAt). */
function networkFailureAt(attempt: AttemptRow): number | undefined {
  const m = /^ambiguous: (?:network|dispatch)(?:@(\d+))?$/u.exec(
    attempt.error ?? ""
  );
  if (!m) return undefined;
  return m[1] ? Number(m[1]) : attempt.createdAt.getTime();
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The human reason of a step: the first textual explanation its event carries, bounded. */
function reasonOf(fields: Record<string, unknown>): string | undefined {
  for (const k of ["reason", "why", "error", "last", "code"]) {
    const v = textOf(fields[k]);
    if (v) return v.slice(0, 300);
  }
  return undefined;
}

function tryForwarded(
  endpoints: readonly string[]
): { host: string; port: number } | undefined {
  try {
    return forwardedTcpEndpoint(endpoints);
  } catch {
    return undefined;
  }
}

function buildShaOf(body: string): string | undefined {
  try {
    const v = (JSON.parse(body) as { buildSha?: unknown }).buildSha;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
