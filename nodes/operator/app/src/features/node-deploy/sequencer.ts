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
 *   - KEY_IS_NEVER_REUSED: every create takes the next attempt ordinal; a failed attempt's key is dead.
 *     An ambiguous create is RESOLVED through `observe(cogniKey)`, never blindly repeated.
 *   - PARK_AFTER_3: after 3 consecutive failed attempts of one release no further paid create happens
 *     until a new release arrives. No clock resets that count.
 *   - PROVE_BEFORE_CUTOVER: the edge never moves until the green lease serves the exact sha
 *     (`/version.buildSha`) and `/readyz` 200 through its provider ingress with the public Host header,
 *     within `proofMs` of lease creation; otherwise the NEW lease is closed and blue keeps serving.
 *   - NOT_BLUES_PROVIDER: a green lease that lands on blue's provider is a failed proof and is closed.
 *   - CUTOVER_IS_READ_BACK: a cutover counts only after the edge record reads back AND 8 consecutive
 *     public reads (DoH) return the exact sha.
 *   - CLOSE_IS_CONFIRMED: a lease counts as closed only after observe says closed AND chain truth
 *     (when wired) agrees. An unconfirmed close is retried by the janitor and alerted, never assumed.
 *   - STATE_IS_NEVER_AUTO_REPLACED: a `state` workload that ever went live is never recreated; loss
 *     only alerts.
 *   - LOST_MEANS_CHAIN_TRUTH: a lease is lost only when chain/observe say closed or insufficient_funds,
 *     or it fails its proof for `unhealthyLostMs` (15 min) straight. A single miss is not a loss.
 *   - ONE_RUNNER_PER_WORKLOAD: `step` and `reconcile` never overlap for one workload key.
 * Side-effects: IO via injected ports
 * @internal
 */

import type {
  ChainTruthPort,
  PayerPort,
  ProbePort,
  SecretsPort,
  SequencerClock,
  SequencerLog,
  StorePort,
} from "@/ports";
import {
  type AttemptPatch,
  type AttemptRow,
  buildCogniKey,
  buildIdentity,
  consecutiveFailures,
  IN_FLIGHT_PHASES,
  keyString,
  PayerError,
  type ReleaseRow,
  type WorkloadKey,
} from "@/ports";
import { forwardedTcpEndpoint, resolveBinding } from "./bindings";
import type { EdgeRouter } from "./edge";
import { ingressHostOf, publicHostOf, toPayerSpec } from "./spec";

export interface SequencerConfig {
  /** The Kubernetes namespace the sequencer runs in; part of every cogniKey. */
  readonly namespace: string;
  /** Lease must report active + an endpoint within this of lease creation. */
  readonly leaseReadyMs: number;
  /** Proof deadline, counted from lease creation (design: 10 min). */
  readonly proofMs: number;
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
  /** A live lease failing its proof this long is treated as lost (design: 15 min). */
  readonly unhealthyLostMs: number;
  readonly pollMs: number;
}

export const DEFAULT_SEQUENCER_CONFIG: Omit<SequencerConfig, "namespace"> = {
  leaseReadyMs: 240_000,
  proofMs: 600_000,
  publicMs: 180_000,
  publicStreak: 8,
  retainMs: 600_000,
  closeConfirmMs: 90_000,
  closeAlertMs: 900_000,
  maxFailedAttempts: 3,
  unhealthyLostMs: 900_000,
  pollMs: 3_000,
};

export interface SequencerDeps {
  readonly store: StorePort;
  readonly payer: PayerPort;
  /** Undefined when no edge credentials are configured: http apps are then refused BEFORE paying. */
  readonly edge: EdgeRouter | undefined;
  readonly probe: ProbePort;
  readonly secrets: SecretsPort;
  readonly chain?: ChainTruthPort;
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

class DependencyNotReady extends Error {}

export class NodeDeploySequencer {
  private readonly running = new Set<string>();

  constructor(private readonly d: SequencerDeps) {}

  // -------------------------------------------------------------------------------------------
  // Loops
  // -------------------------------------------------------------------------------------------

  /** One pass over every desired workload; runs workloads concurrently, never one twice. */
  async tick(): Promise<void> {
    const desired = await this.d.store.listDesired();
    await Promise.all(
      desired.map((row) =>
        this.step(row).catch((error: unknown) =>
          this.d.log.error(
            {
              component: "node-deploy-sequencer",
              ...row,
              step: "step",
              outcome: "threw",
              error: errText(error),
            },
            "node_deploy_step"
          )
        )
      )
    );
  }

  /** One reconcile pass (design: every 60 s). */
  async reconcileAll(): Promise<void> {
    const desired = await this.d.store.listDesired();
    await Promise.all(
      desired.map((row) =>
        this.reconcile(row).catch((error: unknown) =>
          this.d.log.error(
            {
              component: "node-deploy-sequencer",
              ...row,
              step: "reconcile",
              outcome: "threw",
              error: errText(error),
            },
            "node_deploy_step"
          )
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
    const desired = await this.d.store.getDesired(key);
    if (!desired || desired.state !== "running") return "idle";
    const release = await this.d.store.getRelease(desired.releaseId);
    if (!release) {
      this.alert(key, undefined, undefined, "desired_release_missing");
      return "idle";
    }

    await this.janitor(key);
    const all = await this.d.store.attemptsFor(key);

    const inflight = all.find((a) => IN_FLIGHT_PHASES.includes(a.phase));
    const active = all.find((a) => a.phase === "active");
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
    if (consecutiveFailures(ofRelease) >= this.d.config.maxFailedAttempts) {
      this.alert(key, release, undefined, "release_parked", {
        failedAttempts: consecutiveFailures(ofRelease),
      });
      return "parked";
    }

    try {
      await this.resolveEnv(key, release);
    } catch (error) {
      if (error instanceof DependencyNotReady) {
        this.emit(key, release, undefined, "dependency", "waiting", {
          reason: error.message,
        });
        return "waiting_dependency";
      }
      throw error;
    }

    const attempt = await this.d.store.insertAttempt(release.id, (n) =>
      buildCogniKey({
        namespace: this.d.config.namespace,
        nodeId: key.nodeId,
        workload: key.workload,
        releaseId: release.id,
        attempt: n,
      })
    );
    this.emit(key, release, attempt, "attempt_planned", "ok", {
      blue: active?.externalName,
    });
    await this.drive(key, release, attempt, active);
    return "driven";
  }

  /** Run one attempt forward as far as it can go in this call. */
  private async drive(
    key: WorkloadKey,
    release: ReleaseRow,
    start: AttemptRow,
    blue: AttemptRow | undefined
  ): Promise<void> {
    let a = start;
    if (a.phase === "planned") a = await this.doCreate(key, release, a);
    if (a.phase === "created") a = await this.awaitLease(key, release, a, blue);
    if (a.phase === "proving") a = await this.prove(key, release, a);
    if (a.phase === "proven") await this.cutover(key, release, a, blue);
  }

  // ---- create ---------------------------------------------------------------------------------

  private async resolveEnv(
    key: WorkloadKey,
    release: ReleaseRow
  ): Promise<Record<string, string>> {
    const w = release.spec;
    const env: Record<string, string> = {};
    if (w.kind === "app") env.RELEASE_SHA = release.sourceSha;
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
    return env;
  }

  private async doCreate(
    key: WorkloadKey,
    release: ReleaseRow,
    attempt: AttemptRow
  ): Promise<AttemptRow> {
    const w = release.spec;
    if (publicHostOf(w) && !this.d.edge) {
      // Refuse BEFORE paying: a lease no edge can ever route to is wasted spend.
      return this.failAttempt(key, release, attempt, "edge_not_configured");
    }
    let env: Record<string, string>;
    try {
      env = await this.resolveEnv(key, release);
    } catch (error) {
      return this.failAttempt(key, release, attempt, errText(error));
    }

    // Resume path: a previous call left this create unresolved. Resolve, never blindly re-create.
    if (attempt.error?.startsWith("ambiguous")) {
      try {
        const obs = await this.d.payer.observe({ cogniKey: attempt.cogniKey });
        if (obs.found && obs.resource) {
          this.emit(
            key,
            release,
            attempt,
            "create",
            "adopted_after_ambiguity",
            {
              dseq: obs.resource.externalName,
            }
          );
          return this.bindLease(key, release, attempt, obs.resource);
        }
        return this.failAttempt(
          key,
          release,
          attempt,
          "ambiguous create resolved to nothing; next ordinal"
        );
      } catch (error) {
        this.emit(key, release, attempt, "create", "observe_unavailable", {
          error: errText(error),
        });
        return attempt;
      }
    }

    try {
      const resource = await this.d.payer.create({
        cogniKey: attempt.cogniKey,
        environment: release.env,
        identity: buildIdentity({
          nodeId: key.nodeId,
          releaseId: release.id,
          attempt: attempt.attempt,
        }),
        spec: toPayerSpec(w, env),
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
            this.emit(key, release, attempt, "create", "wallet_busy");
            return attempt;
          }
          return this.failAttempt(key, release, attempt, "wallet_busy_timeout");
        }
        if (error.ambiguous) {
          const marked = await this.d.store.updateAttempt(attempt.id, {
            error: `ambiguous: ${error.code}`,
          });
          this.emit(key, release, marked, "create", "ambiguous", {
            code: error.code,
          });
          // Resolve now; on a failed read the marker makes the next tick resolve first.
          return this.doCreate(key, release, marked);
        }
        return this.failAttempt(
          key,
          release,
          attempt,
          `create refused: ${error.code}: ${error.message}`
        );
      }
      return this.failAttempt(key, release, attempt, errText(error));
    }
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
      leasedAt: new Date(this.d.clock.now()),
      ...(resource.providerAccount
        ? { provider: resource.providerAccount }
        : {}),
    };
    const next = await this.d.store.updateAttempt(attempt.id, patch);
    this.emit(key, release, next, "created", "ok", {
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
        this.emit(key, release, a, "lease_ready", "observe_error", {
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
          this.emit(key, release, a, "lease_active", "ok", {
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
          if (v.status === 200 && buildShaOf(v.body) === release.sourceSha) {
            const r = await this.d.probe.hostRouted(
              ingress,
              host,
              health.ready
            );
            if (r.status === 200) {
              const next = await this.d.store.updateAttempt(attempt.id, {
                phase: "proven",
              });
              this.emit(key, release, next, "proven", "ok", {
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
          this.emit(key, release, next, "proven", "ok", {
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
      if (this.d.clock.now() >= deadline)
        return this.failAttempt(
          key,
          release,
          attempt,
          `proof_timeout: ${last}`
        );
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
        const rec = await edge.point(host, ingress);
        touched = true;
        this.emit(key, release, attempt, "edge_moved", "ok", {
          record: rec.id,
          target: rec.content,
        });
        const firstAt = await this.awaitPublic(
          host,
          release.sourceSha,
          w.health?.version ?? "/version"
        );
        this.emit(key, release, attempt, "public_readback", "ok", {
          host,
          consecutive: this.d.config.publicStreak,
          firstAt,
        });
      } catch (error) {
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
    this.emit(key, release, active, "activated", "ok", {
      dseq: active.externalName,
    });
    if (blue && blue.id !== active.id && blue.phase === "active") {
      const retiring = await this.d.store.updateAttempt(blue.id, {
        phase: "retiring",
      });
      this.emit(key, release, retiring, "blue_retiring", "ok", {
        dseq: retiring.externalName,
        retainMs: this.d.config.retainMs,
      });
    }
  }

  /** Poll the PUBLIC host until `publicStreak` consecutive reads return the exact sha. */
  private async awaitPublic(
    host: string,
    sha: string,
    versionPath: string
  ): Promise<string> {
    const { clock, probe, config } = this.d;
    const deadline = clock.now() + config.publicMs;
    let streak = 0;
    let firstAt = "";
    let last = "";
    for (;;) {
      const v = await probe.publicDoh(host, `${versionPath}?cb=${clock.now()}`);
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

  /** Mark failed (counting toward the park), close the lease if one exists, confirm it. */
  private async failAttempt(
    key: WorkloadKey,
    release: ReleaseRow,
    attempt: AttemptRow,
    reason: string
  ): Promise<AttemptRow> {
    const trimmed = reason.slice(0, 500);
    if (!attempt.externalName) {
      const next = await this.d.store.updateAttempt(attempt.id, {
        phase: "failed",
        error: trimmed,
      });
      this.emit(key, release, next, "attempt_failed", "failed", {
        reason: trimmed,
      });
      return next;
    }
    const closing = await this.d.store.updateAttempt(attempt.id, {
      phase: "closing",
      error: trimmed,
    });
    this.emit(key, release, closing, "attempt_failed", "closing", {
      reason: trimmed,
      dseq: closing.externalName,
    });
    const confirmed = await this.closeAndConfirm(closing);
    if (!confirmed) {
      this.alert(key, release, closing, "close_unconfirmed", {
        reason: trimmed,
      });
      return closing;
    }
    const failed = await this.d.store.updateAttempt(attempt.id, {
      phase: "failed",
    });
    this.emit(key, release, failed, "new_closed", "ok", {
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
            this.emit(key, release, retired, "old_closed", "ok", {
              dseq: retired.externalName,
              verified: true,
            });
        } else if (
          release &&
          age >= this.d.config.retainMs + this.d.config.closeAlertMs
        ) {
          this.alert(key, release, a, "close_unconfirmed");
        }
      } else if (a.phase === "closing") {
        const release = await this.d.store.getRelease(a.releaseId);
        if (await this.closeAndConfirm(a)) {
          const failed = await this.d.store.updateAttempt(a.id, {
            phase: "failed",
          });
          if (release)
            this.emit(key, release, failed, "new_closed", "ok", {
              dseq: failed.externalName,
              verified: true,
            });
        } else if (release) {
          this.alert(key, release, a, "close_unconfirmed");
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
      const healthy = await this.quickProof(release, active);
      if (healthy) {
        if (active.unhealthySince) {
          await this.d.store.updateAttempt(active.id, { unhealthySince: null });
          this.emit(key, release, active, "unhealthy_cleared", "ok");
        }
        return "healthy";
      }
      const since = active.unhealthySince ?? new Date(this.d.clock.now());
      if (!active.unhealthySince) {
        await this.d.store.updateAttempt(active.id, { unhealthySince: since });
        this.alert(key, release, active, "proof_failing", {});
        return "unhealthy_waiting";
      }
      if (
        this.d.clock.now() - since.getTime() >=
        this.d.config.unhealthyLostMs
      ) {
        // A failing but LIVE lease is closed and confirmed before anything replaces it.
        if (await this.closeAndConfirm(active))
          return this.handleLost(key, release, active, "proof_failed_15m");
        this.alert(key, release, active, "close_unconfirmed", {
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
      this.alert(key, release, lost, "state_lease_lost", { why });
      return "lost_state_alert";
    }
    this.emit(key, release, lost, "lease_lost", "lost", { why });
    return "lost_app";
  }

  private async quickProof(
    release: ReleaseRow,
    a: AttemptRow
  ): Promise<boolean> {
    const w = release.spec;
    const host = publicHostOf(w);
    const ingress = ingressHostOf(a.endpoints, host);
    if (!host || !ingress || !w.health) return true;
    const v = await this.d.probe.hostRouted(ingress, host, w.health.version);
    if (v.status !== 200 || buildShaOf(v.body) !== release.sourceSha)
      return false;
    const r = await this.d.probe.hostRouted(ingress, host, w.health.ready);
    return r.status === 200;
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

  private emit(
    key: WorkloadKey,
    release: ReleaseRow | undefined,
    attempt: AttemptRow | undefined,
    step: string,
    outcome: string,
    extra: Record<string, unknown> = {}
  ): void {
    this.d.log.info(
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
      "node_deploy_step"
    );
  }

  private alert(
    key: WorkloadKey,
    release: ReleaseRow | undefined,
    attempt: AttemptRow | undefined,
    reason: string,
    extra: Record<string, unknown> = {}
  ): void {
    this.d.log.error(
      {
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
      },
      "node_deploy_alert"
    );
  }
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
