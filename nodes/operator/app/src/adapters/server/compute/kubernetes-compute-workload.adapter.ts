// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  type CoordinationV1Api,
  type CoreV1Api,
  type CoreV1Event,
  type CustomObjectsApi,
  PatchUtils,
  type V1ConfigMap,
  type V1Lease,
} from "@kubernetes/client-node";
import type {
  ComputeWorkload,
  ComputeWorkloadStatePort,
  ComputeWorkloadStatus,
} from "@/ports";

const GROUP = "compute.cogni.io";
const VERSION = "v1alpha1";
const PLURAL = "computeworkloads";
const ALLOCATION_LEDGER = "compute-workload-allocation-ledger";
/**
 * Grace before reclaiming a cursor-bearing orphaned slot, sized to the controller's
 * reconcile tick (15s in the bootstrap). A cursor marks an in-flight provider POST:
 * if a human force-deletes the CR (finalizer stripped) while a zombie process is
 * mid-create, an immediate reclaim could double-allocate. The POST itself lasts
 * seconds, so one full tick closes that window; a controller restart merely resets
 * the sighting map and delays the reclaim by one more tick.
 */
const CURSOR_ORPHAN_RECLAIM_GRACE_MS = 15_000;
const PATCH_HEADERS = {
  headers: { "content-type": PatchUtils.PATCH_FORMAT_JSON_MERGE_PATCH },
};

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    statusCode?: number;
    response?: { statusCode?: number };
  };
  return candidate.statusCode ?? candidate.response?.statusCode;
}

interface WalletAllocationRecord {
  readonly attemptKey: string;
  readonly workloadUid: string;
  readonly allocationCursor?: string;
}

/**
 * Minimal structured-log seam (pino-compatible). An orphan reclaim replaces what used
 * to be a human hand-clearing the ledger ConfigMap, so it must land in Loki loudly.
 */
export interface WalletLedgerLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

function parseWalletAllocation(
  raw: string | undefined
): WalletAllocationRecord | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<WalletAllocationRecord>;
    if (
      typeof value.attemptKey !== "string" ||
      typeof value.workloadUid !== "string"
    )
      return undefined;
    return value as WalletAllocationRecord;
  } catch {
    return undefined;
  }
}

/** Kubernetes API adapter: Git/Argo owns spec; this adapter owns metadata guards + status. */
export class KubernetesComputeWorkloadStateAdapter
  implements ComputeWorkloadStatePort
{
  /**
   * First-sighting times of cursor-bearing orphaned slot records (keyed by the raw
   * ledger JSON, so any change to the record restarts the grace window). In-process
   * on purpose: persisting it would recreate the very never-cleared state bug.5115
   * is about, and losing it on restart only delays a reclaim by one tick.
   */
  private readonly cursorOrphanSeenAtMs = new Map<string, number>();

  constructor(
    private readonly custom: CustomObjectsApi,
    private readonly core: CoreV1Api,
    private readonly namespace: string,
    private readonly instanceIdentity: string,
    private readonly log?: WalletLedgerLogger
  ) {}

  async list(): Promise<readonly ComputeWorkload[]> {
    const response = await this.custom.listNamespacedCustomObject(
      GROUP,
      VERSION,
      this.namespace,
      PLURAL
    );
    const body = response.body as { items?: ComputeWorkload[] };
    return body.items ?? [];
  }

  async claimAttempt(input: {
    resource: ComputeWorkload;
    receipt: string;
  }): Promise<boolean> {
    const resourceVersion = input.resource.metadata.resourceVersion;
    if (!resourceVersion) {
      throw new Error(
        "ComputeWorkload metadata.resourceVersion is required for mutation CAS"
      );
    }
    try {
      await this.custom.patchNamespacedCustomObject(
        GROUP,
        VERSION,
        this.namespace,
        PLURAL,
        input.resource.metadata.name,
        {
          metadata: {
            resourceVersion,
            annotations: {
              "compute.cogni.io/last-attempt": input.receipt,
            },
          },
        },
        undefined,
        "compute-workload-controller",
        undefined,
        PATCH_HEADERS
      );
      return true;
    } catch (error) {
      if (statusCode(error) === 409) return false;
      throw error;
    }
  }

  async claimWalletAllocation(input: {
    attemptKey: string;
    workloadUid: string;
  }): Promise<
    | { state: "claimed"; allocationCursor?: string }
    | { state: "owned"; allocationCursor?: string }
    | { state: "blocked"; ownerAttemptKey: string }
  > {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.readWalletLedger(true);
      const active = parseWalletAllocation(current.data?.active);
      if (active?.attemptKey === input.attemptKey) {
        return {
          state: "owned",
          ...(active.allocationCursor
            ? { allocationCursor: active.allocationCursor }
            : {}),
        };
      }
      let orphan: WalletAllocationRecord | undefined;
      if (active) {
        // bug.5115: a slot whose recorded ComputeWorkload no longer exists can never be
        // released — `completeWalletAllocation` and `recoverUncertainAllocation` both
        // run under the owner's reconcile, and a deleted CR is never reconciled again.
        // Left alone, one orphaned slot deadlocks every wallet mutation fleet-wide.
        // Reclaim ONLY when the CR is gone; a live CR (however slow its reconcile, and
        // even with an uncertain in-flight allocationCursor) legitimately owns the slot.
        if (await this.workloadExists(active.workloadUid)) {
          return { state: "blocked", ownerAttemptKey: active.attemptKey };
        }
        if (active.allocationCursor) {
          // Force-delete-mid-POST window: a cursor plus a deleted CR can also mean a
          // human stripped the finalizer while a zombie process's provider POST was
          // still in flight. Reclaim only on a second sighting of the SAME record at
          // least one reconcile tick later (see CURSOR_ORPHAN_RECLAIM_GRACE_MS).
          const sightingKey = current.data?.active ?? "";
          const firstSeenAtMs = this.cursorOrphanSeenAtMs.get(sightingKey);
          const nowMs = Date.now();
          if (firstSeenAtMs === undefined) {
            this.cursorOrphanSeenAtMs.set(sightingKey, nowMs);
            return { state: "blocked", ownerAttemptKey: active.attemptKey };
          }
          if (nowMs - firstSeenAtMs < CURSOR_ORPHAN_RECLAIM_GRACE_MS) {
            return { state: "blocked", ownerAttemptKey: active.attemptKey };
          }
        }
        orphan = active;
      }
      // Never write blind: omitting a missing resourceVersion would turn this CAS
      // into an unconditional overwrite and let two concurrent claimants both win.
      const resourceVersion = current.metadata?.resourceVersion;
      if (!resourceVersion) {
        throw new Error(
          "wallet allocation ledger metadata.resourceVersion is required for CAS"
        );
      }
      try {
        await this.core.replaceNamespacedConfigMap(
          ALLOCATION_LEDGER,
          this.namespace,
          {
            metadata: {
              name: ALLOCATION_LEDGER,
              namespace: this.namespace,
              resourceVersion,
            },
            data: {
              ...(current.data ?? {}),
              active: JSON.stringify(input),
            },
          }
        );
        // The slot is ours: any recorded orphan sightings are about a record that no
        // longer exists, so drop them (also bounds the map).
        this.cursorOrphanSeenAtMs.clear();
        if (orphan) {
          // This event replaces a human hand-clearing the ledger; it must be loud in
          // Loki. The orphan's cursor (an unresolved provider mutation nobody will ever
          // reconcile) is preserved here for forensics before the record is overwritten.
          this.log?.warn(
            {
              orphanedAttemptKey: orphan.attemptKey,
              orphanedWorkloadUid: orphan.workloadUid,
              ...(orphan.allocationCursor
                ? { orphanedAllocationCursor: orphan.allocationCursor }
                : {}),
              claimantAttemptKey: input.attemptKey,
              claimantWorkloadUid: input.workloadUid,
            },
            "compute_wallet_allocation_orphan_reclaimed"
          );
        }
        return { state: "claimed" };
      } catch (error) {
        // 409: the ledger moved under us (possibly a concurrent reclaimer winning the
        // same orphaned slot) — re-read and re-evaluate; only one CAS write can land.
        if (statusCode(error) !== 409) throw error;
      }
    }
    return { state: "blocked", ownerAttemptKey: "concurrent-writer" };
  }

  async prepareWalletAllocation(input: {
    attemptKey: string;
    allocationCursor: string;
  }): Promise<void> {
    await this.mutateWalletAllocation(input.attemptKey, (active) => ({
      ...active,
      allocationCursor: input.allocationCursor,
    }));
  }

  async completeWalletAllocation(input: { attemptKey: string }): Promise<void> {
    await this.mutateWalletAllocation(input.attemptKey, () => undefined, true);
  }

  private async mutateWalletAllocation(
    attemptKey: string,
    mutate: (
      active: WalletAllocationRecord
    ) => WalletAllocationRecord | undefined,
    ignoreDifferentOwner = false
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.readWalletLedger(false);
      const active = parseWalletAllocation(current.data?.active);
      if (!active) return;
      if (active.attemptKey !== attemptKey) {
        if (ignoreDifferentOwner) return;
        throw new Error("wallet allocation ledger ownership mismatch");
      }
      const next = mutate(active);
      const data = { ...(current.data ?? {}) };
      if (next) data.active = JSON.stringify(next);
      else delete data.active;
      try {
        await this.core.replaceNamespacedConfigMap(
          ALLOCATION_LEDGER,
          this.namespace,
          {
            metadata: {
              name: ALLOCATION_LEDGER,
              namespace: this.namespace,
              ...(current.metadata?.resourceVersion
                ? { resourceVersion: current.metadata.resourceVersion }
                : {}),
            },
            data,
          }
        );
        return;
      } catch (error) {
        if (statusCode(error) !== 409) throw error;
      }
    }
    throw new Error("wallet allocation ledger CAS retry limit exceeded");
  }

  /**
   * Liveness probe for a wallet-slot owner: does any ComputeWorkload CR in this
   * namespace still carry the recorded uid? A LIST (already the reconciler's cheapest
   * read) rather than a GET by name, because the ledger records only the uid.
   */
  private async workloadExists(uid: string): Promise<boolean> {
    const response = await this.custom.listNamespacedCustomObject(
      GROUP,
      VERSION,
      this.namespace,
      PLURAL
    );
    const items = (response.body as { items?: unknown }).items;
    // Not `list()`: its lenient `?? []` would read a malformed 200 as "zero
    // workloads" and fail OPEN — reclaiming a slot whose owner may be alive.
    if (!Array.isArray(items)) {
      throw new Error(
        "ComputeWorkload list response has no items array; refusing to treat it as an empty cluster"
      );
    }
    return items.some(
      (item) => (item as ComputeWorkload | undefined)?.metadata?.uid === uid
    );
  }

  private async readWalletLedger(
    createIfMissing: boolean
  ): Promise<V1ConfigMap> {
    try {
      return this.assertWalletLedger(
        (
          await this.core.readNamespacedConfigMap(
            ALLOCATION_LEDGER,
            this.namespace
          )
        ).body
      );
    } catch (error) {
      if (statusCode(error) !== 404 || !createIfMissing) throw error;
      try {
        return this.assertWalletLedger(
          (
            await this.core.createNamespacedConfigMap(this.namespace, {
              metadata: { name: ALLOCATION_LEDGER, namespace: this.namespace },
              data: {},
            })
          ).body
        );
      } catch (createError) {
        if (statusCode(createError) !== 409) throw createError;
        return this.assertWalletLedger(
          (
            await this.core.readNamespacedConfigMap(
              ALLOCATION_LEDGER,
              this.namespace
            )
          ).body
        );
      }
    }
  }

  private assertWalletLedger(resource: V1ConfigMap): V1ConfigMap {
    if (
      resource.metadata?.name !== ALLOCATION_LEDGER ||
      (resource.metadata.namespace !== undefined &&
        resource.metadata.namespace !== this.namespace)
    ) {
      throw new Error("wallet allocation ledger identity mismatch");
    }
    return resource;
  }

  async patchMetadata(input: {
    resource: ComputeWorkload;
    annotations?: Readonly<Record<string, string | null>>;
    finalizers?: readonly string[];
  }): Promise<void> {
    await this.custom.patchNamespacedCustomObject(
      GROUP,
      VERSION,
      this.namespace,
      PLURAL,
      input.resource.metadata.name,
      {
        metadata: {
          ...(input.annotations ? { annotations: input.annotations } : {}),
          ...(input.finalizers ? { finalizers: input.finalizers } : {}),
        },
      },
      undefined,
      "compute-workload-controller",
      undefined,
      PATCH_HEADERS
    );
  }

  async patchStatus(input: {
    resource: ComputeWorkload;
    status: ComputeWorkloadStatus;
  }): Promise<void> {
    await this.custom.patchNamespacedCustomObjectStatus(
      GROUP,
      VERSION,
      this.namespace,
      PLURAL,
      input.resource.metadata.name,
      {
        status: {
          ...input.status,
          // This endpoint uses JSON Merge Patch. Omitting an optional field
          // retains its old value, so explicitly delete a resolved failure.
          failure: input.status.failure ?? null,
        },
      },
      undefined,
      "compute-workload-controller",
      undefined,
      PATCH_HEADERS
    );
  }

  async event(input: {
    resource: ComputeWorkload;
    type: "Normal" | "Warning";
    reason: string;
    message: string;
  }): Promise<void> {
    const now = new Date();
    const body: CoreV1Event = {
      metadata: {
        generateName: `${input.resource.metadata.name.toLowerCase()}-`,
        namespace: this.namespace,
      },
      involvedObject: {
        apiVersion: input.resource.apiVersion,
        kind: input.resource.kind,
        name: input.resource.metadata.name,
        namespace: this.namespace,
        uid: input.resource.metadata.uid,
      },
      type: input.type,
      reason: input.reason,
      message: input.message.slice(0, 1024),
      source: { component: "compute-workload-controller" },
      reportingComponent: "compute.cogni.io/controller",
      reportingInstance: this.instanceIdentity,
      firstTimestamp: now,
      lastTimestamp: now,
      count: 1,
    };
    await this.core.createNamespacedEvent(this.namespace, body);
  }
}

/**
 * coordination.k8s.io Lease times are MicroTime: the API server requires
 * exactly six fractional digits and 400s anything else, while the 0.22 client
 * serializes Date with milliseconds. Serialize explicitly (Date's ms precision
 * padded to µs) or every lease create/renew fails as a BadRequest.
 */
function toMicroTime(value: Date): Date {
  return value.toISOString().replace("Z", "000Z") as unknown as Date;
}

/**
 * Why a renewal attempt did not end with this instance holding the lease.
 *
 * The distinction is the whole point: `foreign_holder` is a REAL loss and must fence
 * immediately, while `cas_conflict` is a stale-resourceVersion write that a loaded
 * API server produces routinely and must NOT. Before this existed the fence log
 * carried only `causeType: "Error"`, and three patch rounds guessed at which one it was.
 */
export type LeaseRenewFailureReason =
  | "cas_conflict"
  | "foreign_holder"
  | "expired";

/** Outcome of one `acquireOrRenew` attempt. */
export type LeaseRenewOutcome =
  | { readonly held: true }
  | { readonly held: false; readonly reason: LeaseRenewFailureReason };

/** Default lease deadline. Overridden from env by the controller composition root. */
export const DEFAULT_LEASE_DURATION_SECONDS = 120;

/** Lease-based leader election for the dedicated controller Deployment. */
export class KubernetesLeaseLeaderElector {
  private leader = false;
  private epoch: string | undefined;
  private renewedAtMs = 0;

  constructor(
    private readonly api: CoordinationV1Api,
    private readonly namespace: string,
    private readonly name: string,
    private readonly identity: string,
    private readonly leaseDurationSeconds = DEFAULT_LEASE_DURATION_SECONDS
  ) {}

  isLeader(): boolean {
    return this.leader;
  }

  currentEpoch(): string | undefined {
    return this.leader ? this.epoch : undefined;
  }

  /**
   * True while the last *successful* renewal still covers `now`. No other replica can
   * take over inside that window, so a failed renewal call is not yet a lost lease.
   */
  leaseHeldThrough(now = new Date()): boolean {
    return (
      this.renewedAtMs > 0 &&
      now.getTime() <= this.renewedAtMs + this.leaseDurationSeconds * 1000
    );
  }

  /** Live dispatch guard used after the per-resource CAS and immediately before provider I/O. */
  async stillHolds(epoch: string, now = new Date()): Promise<boolean> {
    try {
      const lease = (
        await this.api.readNamespacedLease(this.name, this.namespace)
      ).body;
      const renewedAt = lease.spec?.renewTime
        ? new Date(lease.spec.renewTime).getTime()
        : 0;
      const duration =
        (lease.spec?.leaseDurationSeconds ?? this.leaseDurationSeconds) * 1000;
      const live = now.getTime() <= renewedAt + duration;
      const actualEpoch = `${lease.spec?.leaseTransitions ?? 0}:${lease.spec?.holderIdentity ?? ""}`;
      return (
        this.leader &&
        live &&
        lease.spec?.holderIdentity === this.identity &&
        actualEpoch === epoch
      );
    } catch {
      return false;
    }
  }

  /**
   * Attempt to hold the lease for another `leaseDurationSeconds`.
   *
   * Returns WHY it failed rather than a bare false: leadership is defined by the lease
   * deadline, not by one API call, so only `foreign_holder` (a different identity holds a
   * live lease) and `expired` (our earned window lapsed) are real losses. A `cas_conflict`
   * is a stale-resourceVersion write that a loaded API server produces routinely, and the
   * instance stays leader through it.
   */
  async acquireOrRenew(now = new Date()): Promise<LeaseRenewOutcome> {
    let existing: V1Lease | undefined;
    try {
      existing = (await this.api.readNamespacedLease(this.name, this.namespace))
        .body;
    } catch (error) {
      // Leadership is defined by the lease deadline, not by one API call. Dropping the
      // held flag here would make the *next* consecutive failure look like an ordinary
      // follower error, so an expired lease could never fence an in-flight mutation.
      if (statusCode(error) !== 404) throw error;
    }

    if (!existing) {
      try {
        await this.api.createNamespacedLease(this.namespace, {
          metadata: { name: this.name, namespace: this.namespace },
          spec: {
            holderIdentity: this.identity,
            leaseDurationSeconds: this.leaseDurationSeconds,
            acquireTime: toMicroTime(now),
            renewTime: toMicroTime(now),
            leaseTransitions: 0,
          },
        });
        this.leader = true;
        this.epoch = `0:${this.identity}`;
        this.renewedAtMs = now.getTime();
        return { held: true };
      } catch (error) {
        if (statusCode(error) !== 409) throw error;
        // Lost the create race: someone else owns the lease now.
        this.leader = false;
        this.epoch = undefined;
        this.renewedAtMs = 0;
        return { held: false, reason: "foreign_holder" };
      }
    }

    const holder = existing.spec?.holderIdentity;
    const renewedAt = existing.spec?.renewTime
      ? new Date(existing.spec.renewTime).getTime()
      : 0;
    const duration =
      (existing.spec?.leaseDurationSeconds ?? this.leaseDurationSeconds) * 1000;
    const expired = now.getTime() > renewedAt + duration;
    if (holder !== this.identity && holder && !expired) {
      this.leader = false;
      this.epoch = undefined;
      this.renewedAtMs = 0;
      return { held: false, reason: "foreign_holder" };
    }

    const transitioned = holder !== this.identity;
    try {
      await this.api.replaceNamespacedLease(this.name, this.namespace, {
        metadata: {
          name: this.name,
          namespace: this.namespace,
          ...(existing.metadata?.resourceVersion
            ? { resourceVersion: existing.metadata.resourceVersion }
            : {}),
        },
        spec: {
          holderIdentity: this.identity,
          leaseDurationSeconds: this.leaseDurationSeconds,
          ...(transitioned
            ? { acquireTime: toMicroTime(now) }
            : existing.spec?.acquireTime
              ? {
                  acquireTime: toMicroTime(new Date(existing.spec.acquireTime)),
                }
              : {}),
          renewTime: toMicroTime(now),
          leaseTransitions:
            (existing.spec?.leaseTransitions ?? 0) + (transitioned ? 1 : 0),
        },
      });
      this.leader = true;
      this.epoch = `${(existing.spec?.leaseTransitions ?? 0) + (transitioned ? 1 : 0)}:${this.identity}`;
      this.renewedAtMs = now.getTime();
      return { held: true };
    } catch (error) {
      if (statusCode(error) !== 409) throw error;
      // A CAS conflict is NOT proof another holder took over. Our cached resourceVersion
      // goes stale routinely on a slow API server (production k3s serves /healthz in
      // 1-10s with a multi-GB kine datastore), and the update then 409s even though we
      // are still the recorded holder.
      //
      // bug.5110: dropping `leader`/`epoch` here was self-harm. It paused `reconcileAll`,
      // and — because the next tick then observed `previouslyHeld === false` — it also
      // ERASED the fence signal, so a genuine loss looked like an ordinary follower tick.
      // Leadership is the earned deadline, so hold it until that deadline actually lapses.
      // `stillHolds()` re-reads the live lease before any provider mutation, so staying
      // leader through a conflict cannot let a stale process mutate a foreign workload.
      if (this.leaseHeldThrough(now)) {
        return { held: false, reason: "cas_conflict" };
      }
      this.leader = false;
      this.epoch = undefined;
      this.renewedAtMs = 0;
      return { held: false, reason: "expired" };
    }
  }
}

export interface RenewableLeaderLease {
  isLeader(): boolean;
  acquireOrRenew(): Promise<LeaseRenewOutcome>;
  leaseHeldThrough(now?: Date): boolean;
}

/** Named cause carried by a fence or a tolerated renew failure, for the controller log. */
export class LeaseRenewError extends Error {
  constructor(
    readonly reason: LeaseRenewFailureReason,
    message: string
  ) {
    super(message);
    this.name = "LeaseRenewError";
  }
}

/**
 * Renew a Lease and fence a process that previously held it on a REAL loss signal.
 * The runtime callback exits immediately: a stale process must never finish provider IO
 * while a replacement leader begins reconciling the same resource.
 *
 * A failed renewal *call* is not a lost lease. Only two outcomes are losses —
 * `foreign_holder` (another identity holds a live lease, so fence at once) and `expired`
 * (the deadline we earned has passed). A `cas_conflict` inside the window is the routine
 * slow-API case: it throws a typed, non-fatal error so the controller can log a
 * discriminated reason and the next tick can retry.
 *
 * bug.5110: fencing on every unsuccessful renewal crashlooped a SINGLE-replica controller
 * on a disk-stressed k3s API — fencing one replica prevents no split-brain, it just
 * strands in-flight provider IO as an unresolvable `prepared` attempt.
 */
export async function renewLeadershipOrFence(
  lease: RenewableLeaderLease,
  onLeadershipLost: (cause: LeaseRenewError) => never
): Promise<boolean> {
  const previouslyHeld = lease.isLeader();
  let outcome: LeaseRenewOutcome;
  try {
    outcome = await lease.acquireOrRenew();
  } catch (error) {
    // An API error is only a loss once the earned window has lapsed.
    if (previouslyHeld && !lease.leaseHeldThrough()) {
      return onLeadershipLost(
        new LeaseRenewError(
          "expired",
          `Kubernetes Lease deadline lapsed during a failing renewal: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
    }
    throw error;
  }
  if (outcome.held) return true;
  if (!previouslyHeld) return false;

  // `foreign_holder` is the ONLY instant fence: a different identity holds a live lease,
  // so a replacement leader is already reconciling and this process must not finish its
  // provider IO. `cas_conflict` inside the window is the routine slow-API case — log it
  // and let the next tick retry. `expired` means the deadline we earned has passed.
  if (outcome.reason === "cas_conflict") {
    throw new LeaseRenewError(
      "cas_conflict",
      "Kubernetes Lease renewal hit a resourceVersion conflict, but the held window has not lapsed"
    );
  }
  return onLeadershipLost(
    new LeaseRenewError(
      outcome.reason,
      outcome.reason === "foreign_holder"
        ? "a different holder now owns a live Kubernetes Lease"
        : "previously held Kubernetes Lease deadline lapsed without a successful renewal"
    )
  );
}
