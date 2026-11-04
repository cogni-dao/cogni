// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/node-deploy.port`
 * Purpose: The node-deploy sequencer's domain types and seams — workload keys, releases, attempts,
 *   the attempt phase machine, and the payer / edge DNS / probe / store / secrets / chain / clock
 *   ports — so the REAL state machine runs unchanged over fakes in tests, over the Akash Console in
 *   local dev (ConsolePayer) and over the private actuator in production (ActuatorPayer). task.5400.
 * Scope: Types, interfaces, one error class and tiny pure helpers. No IO.
 * Invariants:
 *   - PHASES: planned -> created -> proving -> proven -> active -> retiring -> retired. A failure
 *     before cutover goes planned|created|proving|proven -> closing -> failed. A live lease that
 *     chain truth (or a 15-minute failed proof) says is gone goes active -> lost.
 *   - KEY_IS_NEVER_REUSED: `cogniKey` embeds `(release, attempt)`; every create takes the next ordinal.
 *   - ONE_PAYER_PORT: `PayerPort` has exactly two implementations (ActuatorPayer in prod, ConsolePayer
 *     in dev). The sequencer never knows which.
 *   - NO_DNS_DELETE: `DnsRecordsPort` has no delete. The edge can never be withdrawn by construction
 *     (bug.5301); only node removal, which is not this component, deletes a record.
 * Side-effects: none
 * Links: features/node-deploy/sequencer.ts, task.5400, story.5127
 * @public
 */

import type { NodeWorkloadSpec } from "@cogni/repo-spec";

export type { NodeWorkloadSpec };

export type AttemptPhase =
  | "planned"
  | "created"
  | "proving"
  | "proven"
  | "active"
  | "retiring"
  | "retired"
  | "closing"
  | "failed"
  | "lost";

/** Phases in which this attempt is mid-flight and `step` must drive it forward. */
export const IN_FLIGHT_PHASES: readonly AttemptPhase[] = [
  "planned",
  "created",
  "proving",
  "proven",
];

export interface WorkloadKey {
  readonly nodeId: string;
  readonly env: string;
  readonly workload: string;
}

export const keyString = (k: WorkloadKey): string =>
  `${k.nodeId}/${k.env}/${k.workload}`;

export interface ReleaseRow extends WorkloadKey {
  readonly id: string;
  readonly sourceSha: string;
  /**
   * The spec to deploy. While `spec.imagePending` is true its image is the tag node CI publishes at
   * `sourceSha` and NO create may be sent; once the digest is pinned the store returns the spec with that
   * digest as `image` and no `imagePending` (see `pinResolvedImage`).
   */
  readonly spec: NodeWorkloadSpec;
  /** The digest this release pinned (write-once); undefined until the sequencer resolves a pending image. */
  readonly resolvedImage?: string | undefined;
  readonly createdBy: string;
  readonly createdAt: Date;
}

/**
 * The spec a release deploys once its image digest is pinned: the digest replaces the pending tag and the
 * pending flag is dropped. A spec whose image was never pending is returned unchanged.
 */
export function withResolvedImage(
  spec: NodeWorkloadSpec,
  resolvedImage: string | undefined
): NodeWorkloadSpec {
  if (!spec.imagePending || !resolvedImage) return spec;
  const { imagePending: _pending, ...rest } = spec;
  return { ...rest, image: resolvedImage };
}

export type DesiredState = "running" | "stopped";

export interface DesiredRow extends WorkloadKey {
  readonly state: DesiredState;
  readonly releaseId: string;
  readonly updatedAt: Date;
  /** Durable game-day intent (an operator verb), consumed and cleared by the sequencer. */
  readonly gameDayRequestedAt?: Date | undefined;
}

/** Hard cap of persisted steps per attempt; the newest are kept (task.5400 observability). */
export const MAX_ATTEMPT_STEPS = 100;

/**
 * One sequencer step as persisted on its attempt. Written by the SAME `emit` call that logs
 * `node_deploy_step`, so the durable timeline and the Loki event cannot drift.
 */
export interface AttemptStep {
  readonly step: string;
  readonly outcome: string;
  readonly reason?: string | undefined;
  readonly dseq?: string | undefined;
  readonly provider?: string | undefined;
  /** Milliseconds from the attempt row's creation to this step (the step-latency series). */
  readonly elapsedMs?: number | undefined;
  /** ISO-8601 instant the step was emitted. */
  readonly at: string;
}

export interface AttemptRow {
  readonly id: string;
  readonly releaseId: string;
  readonly attempt: number;
  readonly cogniKey: string;
  readonly externalName: string | undefined;
  readonly provider: string | undefined;
  readonly endpoints: readonly string[];
  readonly phase: AttemptPhase;
  readonly error: string | undefined;
  readonly unhealthySince: Date | undefined;
  readonly createdAt: Date;
  readonly leasedAt: Date | undefined;
  readonly updatedAt: Date;
  /** Oldest first, at most `MAX_ATTEMPT_STEPS`. Empty for attempts that predate the timeline. */
  readonly steps: readonly AttemptStep[];
}

export interface AttemptPatch {
  phase?: AttemptPhase;
  externalName?: string;
  provider?: string;
  endpoints?: readonly string[];
  error?: string | null;
  unhealthySince?: Date | null;
  leasedAt?: Date;
}

/**
 * `nd:<k8s-namespace>:<nodeId>:<workload>:<releaseId>:<attempt>` — the actuator idempotency key
 * (task.5400 binding rule). Url-safe by construction: every segment is a DNS label or a uuid.
 */
export function buildCogniKey(input: {
  readonly namespace: string;
  readonly nodeId: string;
  readonly workload: string;
  readonly releaseId: string;
  readonly attempt: number;
}): string {
  return `nd:${input.namespace}:${input.nodeId}:${input.workload}:${input.releaseId}:${input.attempt}`;
}

/** The actuator wire's stated identity for one attempt. Never derived from the key. */
export function buildIdentity(input: {
  readonly nodeId: string;
  readonly releaseId: string;
  readonly attempt: number;
}): {
  nodeId: string;
  compositeUid: string;
  compositeGeneration: number;
} {
  return {
    nodeId: input.nodeId,
    compositeUid: `nd-${input.releaseId}`,
    compositeGeneration: input.attempt,
  };
}

/** Consecutive failed attempts of ONE release, counted from the newest backwards. */
export function consecutiveFailures(
  attemptsNewestFirst: readonly AttemptRow[]
): number {
  let n = 0;
  for (const a of attemptsNewestFirst) {
    if (a.phase === "failed" || a.phase === "closing") n++;
    else break;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// Payer
// ---------------------------------------------------------------------------------------------

/** The provider-agnostic spec on the actuator v1 wire (`AkashTxSpecSchema`). */
export interface PayerSpec {
  readonly name: string;
  /**
   * Hard placement requirement (ISO 3166-1 alpha-2), from the node's catalog policy
   * `required_placement_countries[<env>]` (task.5405). Absent = the actuator's default screening.
   */
  readonly placement?: { readonly requiredCountryCodes: readonly string[] };
  readonly services: readonly {
    readonly name: string;
    readonly image: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly command?: readonly string[];
    readonly args?: readonly string[];
    readonly cpuUnits: number;
    readonly memoryMi: number;
    readonly storageMi: number;
    readonly volumes?: readonly {
      readonly name: string;
      readonly sizeMi: number;
      readonly mountPath: string;
      readonly tier: "hdd" | "ssd" | "nvme";
    }[];
    readonly expose?: readonly {
      readonly port: number;
      readonly as: number;
      readonly global: boolean;
      readonly hosts?: readonly string[];
    }[];
  }[];
}

export interface PayerCreateRequest {
  readonly cogniKey: string;
  readonly environment: string;
  readonly identity: {
    readonly nodeId: string;
    readonly compositeUid: string;
    readonly compositeGeneration: number;
  };
  readonly spec: PayerSpec;
  /**
   * Providers that must NOT win this create: the provider currently serving blue, because two leases
   * on one provider ingress cannot both claim one host. Both payers honor it (ConsolePayer filters its
   * bids; ActuatorPayer sends it on the v1 wire, where the actuator UNIONS it into its tried-provider
   * set so it can only narrow the eligible bids). The sequencer's post-hoc `same_provider_as_blue`
   * proof refusal stays as the backstop.
   */
  readonly excludeProviders?: readonly string[];
  /**
   * Providers this create MAY win (task.5405): the interim set whose egress is admitted to the
   * shared substrate. The actuator INTERSECTS it with its own configured allowlist (never widens it)
   * and refuses with a clear reason when the intersection is empty. Only ActuatorPayer sends it;
   * the dev ConsolePayer ignores it. Absent = no caller allowlist.
   */
  readonly allowProviders?: readonly string[];
}

export interface PayerResource {
  /** Opaque provider handle (the Akash dseq). */
  readonly externalName: string;
  readonly state: "pending" | "active" | "closed" | "unknown";
  /** Ingress hosts (no scheme) and `tcp://host:port` forwarded ports. */
  readonly endpoints: readonly string[];
  readonly providerAccount: string | undefined;
}

export type PayerErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "not_found"
  | "wallet_allocation_blocked"
  | "allocation_unresolved"
  | "allocation_ambiguous"
  | "allocation_rolled_back"
  | "provider_rejected"
  | "placement_violated_by_incumbent"
  | "identity_conflict"
  | "provider_unavailable"
  | "outcome_unknown"
  | "ledger_unavailable"
  | "network";

/**
 * Failure of a payer call. `ambiguous` means "a paid lease MAY exist under this key": the caller
 * must resolve it through `observe(cogniKey)` and must NEVER blindly create again.
 * `definitive` (bug.5569) means the payer guarantees NOTHING bills under this key: the create was
 * refused before any deployment existed, or the deployment it opened was closed and that close was
 * read back. The caller may fail the attempt at once, with no `observe`. Absent is the safe answer.
 */
export class PayerError extends Error {
  constructor(
    readonly code: PayerErrorCode,
    message: string,
    readonly ambiguous: boolean,
    readonly definitive = false
  ) {
    super(message);
    this.name = "PayerError";
  }
}

export interface PayerPort {
  /** Idempotent by `cogniKey`. Returns once the lease exists; boot convergence is the caller's. */
  create(req: PayerCreateRequest): Promise<PayerResource>;
  /** Unpaid read. `found:false` means no resource exists under this key. */
  observe(req: {
    readonly cogniKey: string;
    readonly externalName?: string;
  }): Promise<{ found: boolean; resource?: PayerResource }>;
  delete(req: {
    readonly cogniKey: string;
    readonly externalName: string;
  }): Promise<void>;
}

/** Independent chain/Console truth for a deployment, used to cross-check a close and detect loss. */
export interface ChainTruthPort {
  deploymentState(
    externalName: string
  ): Promise<"active" | "closed" | "insufficient_funds" | "unknown">;
}

// ---------------------------------------------------------------------------------------------
// Edge DNS
// ---------------------------------------------------------------------------------------------

export interface DnsRecord {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly content: string;
  readonly proxied: boolean;
}

export interface DnsRecordInput {
  readonly type: "CNAME";
  readonly name: string;
  readonly content: string;
  readonly proxied: true;
}

/** Cloudflare zone records. Deliberately NO delete (NO_DNS_DELETE). */
export interface DnsRecordsPort {
  findByName(name: string): Promise<readonly DnsRecord[]>;
  create(input: DnsRecordInput): Promise<DnsRecord>;
  update(id: string, input: DnsRecordInput): Promise<DnsRecord>;
  read(id: string): Promise<DnsRecord>;
}

// ---------------------------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------------------------

export interface HttpResult {
  readonly status: number;
  readonly body: string;
  readonly ms: number;
  readonly error?: string;
}

export interface ProbePort {
  /** GET `http://<ingressHost><path>` presenting `Host: <hostHeader>` (the provider's host routing). */
  hostRouted(
    ingressHost: string,
    hostHeader: string,
    path: string
  ): Promise<HttpResult>;
  /** GET `https://<host><path>` resolved through Cloudflare DoH, bypassing any local resolver. */
  publicDoh(host: string, path: string): Promise<HttpResult>;
  /** Postgres SSLRequest handshake against a forwarded tcp port. */
  tcpTls(host: string, port: number): Promise<boolean>;
}

// ---------------------------------------------------------------------------------------------
// Store / secrets / clock / log
// ---------------------------------------------------------------------------------------------

export interface RecordReleaseInput extends WorkloadKey {
  readonly sourceSha: string;
  readonly spec: NodeWorkloadSpec;
  readonly createdBy: string;
}

export interface StorePort {
  getDesired(key: WorkloadKey): Promise<DesiredRow | undefined>;
  /** Record a game-day intent on an existing desired row. False when the workload has no desired row. */
  requestGameDay(key: WorkloadKey): Promise<boolean>;
  /** Clear a consumed game-day intent. */
  clearGameDay(key: WorkloadKey): Promise<void>;
  /** Desired rows for ONE deployment environment. A sequencer only ever lists its own env (CD4). */
  listDesired(env: string): Promise<readonly DesiredRow[]>;
  getRelease(id: string): Promise<ReleaseRow | undefined>;
  /**
   * Pin the digest a pending-image release deploys. WRITE_ONCE: only the first call writes
   * (`resolved_image IS NULL`); a later call returns the already pinned row unchanged, so every attempt of a
   * release deploys one image. Returns the release with its spec normalized (`withResolvedImage`).
   */
  pinResolvedImage(releaseId: string, image: string): Promise<ReleaseRow>;
  /** Write the immutable release AND point desired at it (state `running`) in one transaction. */
  recordRelease(
    input: RecordReleaseInput
  ): Promise<{ release: ReleaseRow; desired: DesiredRow }>;
  /** Every attempt of the workload across releases, newest first (created_at desc). */
  attemptsFor(key: WorkloadKey): Promise<readonly AttemptRow[]>;
  /**
   * Insert the next attempt (phase `planned`) of a release. The ordinal is allocated by the store
   * and the key by `makeKey`, both before the row is visible. KEY_IS_NEVER_REUSED.
   */
  insertAttempt(
    releaseId: string,
    makeKey: (attempt: number) => string
  ): Promise<AttemptRow>;
  updateAttempt(id: string, patch: AttemptPatch): Promise<AttemptRow>;
  /**
   * Append one step to the attempt's timeline (atomic; keeps the newest `MAX_ATTEMPT_STEPS`).
   * Observability only: it never changes `phase`, and a failure here must never fail a deploy.
   */
  appendAttemptStep(attemptId: string, step: AttemptStep): Promise<void>;
}

export interface SecretsPort {
  /** Read the generated state password for `nd-<workload>-<env>`; undefined when absent. */
  getStatePassword(key: WorkloadKey): Promise<string | undefined>;
  /** Create once (never overwrite), return the stored value. */
  ensureStatePassword(key: WorkloadKey): Promise<string>;
}

export interface SequencerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface SequencerLog {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}
