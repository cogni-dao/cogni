// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/testing`
 * Purpose: In-memory fakes (store, payer, DNS, probes, secrets, clock) so the REAL sequencer state
 *   machine runs in unit tests and in the local live harness with no network (task.5400).
 * Scope: Test support only; imported by `*.test.ts`. Never imported by the sequencer bootstrap.
 * Invariants:
 *   - FAKE_CLOCK_SLEEP_ADVANCES: `sleep(ms)` advances time instead of waiting, so a 10-minute proof
 *     deadline costs microseconds.
 *   - FAKE_DNS_HAS_NO_DELETE: mirrors `DnsRecordsPort` exactly.
 * Side-effects: none
 * @internal
 */

import type {
  AttemptPatch,
  AttemptRow,
  ChainTruthPort,
  DesiredRow,
  DnsRecord,
  DnsRecordInput,
  DnsRecordsPort,
  HttpResult,
  NodeWorkloadSpec,
  PayerCreateRequest,
  PayerPort,
  PayerResource,
  ProbePort,
  RecordReleaseInput,
  ReleaseRow,
  SecretsPort,
  SequencerClock,
  SequencerLog,
  StorePort,
  WorkloadKey,
} from "@/ports";
import { keyString, PayerError } from "@/ports";

export const NODE_ID = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
export const ENV = "production";
export const SHA_1 = "1".repeat(40);
export const SHA_2 = "2".repeat(40);
export const SHA_3 = "3".repeat(40);
export const DIGEST = `sha256:${"a".repeat(64)}`;
export const PUBLIC_HOST = "node-deploy-canary.cognidao.org";

export class FakeClock implements SequencerClock {
  constructor(public t = 1_800_000_000_000) {}
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export class MemoryLog implements SequencerLog {
  readonly lines: {
    level: string;
    fields: Record<string, unknown>;
    msg: string;
  }[] = [];
  info(fields: Record<string, unknown>, msg: string): void {
    this.lines.push({ level: "info", fields, msg });
  }
  warn(fields: Record<string, unknown>, msg: string): void {
    this.lines.push({ level: "warn", fields, msg });
  }
  error(fields: Record<string, unknown>, msg: string): void {
    this.lines.push({ level: "error", fields, msg });
  }
  steps(): string[] {
    return this.lines
      .filter((l) => l.msg === "node_deploy_step")
      .map((l) => `${String(l.fields.step)}:${String(l.fields.outcome)}`);
  }
  alerts(): string[] {
    return this.lines
      .filter((l) => l.msg === "node_deploy_alert")
      .map((l) => String(l.fields.outcome));
  }
}

export class MemoryStore implements StorePort {
  readonly releases = new Map<string, ReleaseRow>();
  readonly desired = new Map<string, DesiredRow>();
  readonly attempts: AttemptRow[] = [];
  private seq = 0;
  constructor(private readonly clock: SequencerClock) {}

  async getDesired(key: WorkloadKey): Promise<DesiredRow | undefined> {
    return this.desired.get(keyString(key));
  }
  async listDesired(env: string): Promise<readonly DesiredRow[]> {
    return [...this.desired.values()].filter((d) => d.env === env);
  }
  async getRelease(id: string): Promise<ReleaseRow | undefined> {
    return this.releases.get(id);
  }
  async recordRelease(
    input: RecordReleaseInput
  ): Promise<{ release: ReleaseRow; desired: DesiredRow }> {
    const release: ReleaseRow = {
      id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`,
      nodeId: input.nodeId,
      env: input.env,
      workload: input.workload,
      sourceSha: input.sourceSha,
      spec: input.spec,
      createdBy: input.createdBy,
      createdAt: new Date(this.clock.now()),
    };
    this.releases.set(release.id, release);
    const desired: DesiredRow = {
      nodeId: input.nodeId,
      env: input.env,
      workload: input.workload,
      state: "running",
      releaseId: release.id,
      updatedAt: new Date(this.clock.now()),
    };
    this.desired.set(keyString(input), desired);
    return { release, desired };
  }
  setDesiredState(key: WorkloadKey, state: "running" | "stopped"): void {
    const cur = this.desired.get(keyString(key));
    if (cur) this.desired.set(keyString(key), { ...cur, state });
  }
  private releaseKey(a: AttemptRow): WorkloadKey | undefined {
    return this.releases.get(a.releaseId);
  }
  async attemptsFor(key: WorkloadKey): Promise<readonly AttemptRow[]> {
    // Newest first by insertion order (the real store orders by created_at desc).
    return this.attempts
      .filter((a) => {
        const r = this.releaseKey(a);
        return r && keyString(r) === keyString(key);
      })
      .reverse();
  }
  async insertAttempt(
    releaseId: string,
    makeKey: (attempt: number) => string
  ): Promise<AttemptRow> {
    const n =
      Math.max(
        0,
        ...this.attempts
          .filter((a) => a.releaseId === releaseId)
          .map((a) => a.attempt)
      ) + 1;
    const cogniKey = makeKey(n);
    if (this.attempts.some((a) => a.cogniKey === cogniKey))
      throw new Error(`duplicate cogni_key ${cogniKey}`);
    const now = new Date(this.clock.now());
    const row: AttemptRow = {
      id: `attempt-${this.attempts.length + 1}`,
      releaseId,
      attempt: n,
      cogniKey,
      externalName: undefined,
      provider: undefined,
      endpoints: [],
      phase: "planned",
      error: undefined,
      unhealthySince: undefined,
      createdAt: now,
      leasedAt: undefined,
      updatedAt: now,
    };
    this.attempts.push(row);
    return row;
  }
  async updateAttempt(id: string, patch: AttemptPatch): Promise<AttemptRow> {
    const i = this.attempts.findIndex((a) => a.id === id);
    const cur = this.attempts[i];
    if (!cur) throw new Error(`no attempt ${id}`);
    const next: AttemptRow = {
      ...cur,
      ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
      ...(patch.externalName !== undefined
        ? { externalName: patch.externalName }
        : {}),
      ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
      ...(patch.endpoints !== undefined ? { endpoints: patch.endpoints } : {}),
      ...(patch.error !== undefined ? { error: patch.error ?? undefined } : {}),
      ...(patch.unhealthySince !== undefined
        ? { unhealthySince: patch.unhealthySince ?? undefined }
        : {}),
      ...(patch.leasedAt !== undefined ? { leasedAt: patch.leasedAt } : {}),
      updatedAt:
        patch.phase !== undefined ? new Date(this.clock.now()) : cur.updatedAt,
    };
    this.attempts[i] = next;
    return next;
  }
}

export class MemorySecrets implements SecretsPort {
  readonly created: string[] = [];
  private readonly values = new Map<string, string>();
  async getStatePassword(key: WorkloadKey): Promise<string | undefined> {
    return this.values.get(keyString(key));
  }
  async ensureStatePassword(key: WorkloadKey): Promise<string> {
    const k = keyString(key);
    let v = this.values.get(k);
    if (!v) {
      v = `pw-${this.values.size + 1}-s3cr3t/with+chars`;
      this.values.set(k, v);
      this.created.push(k);
    }
    return v;
  }
}

interface FakeLease {
  dseq: string;
  cogniKey: string;
  provider: string;
  state: "active" | "closed";
  endpoints: string[];
  env: Record<string, string>;
  /** Override the sha the lease serves (default: its RELEASE_SHA env). */
  serveSha?: string;
  notReady?: boolean;
  down?: boolean;
  tlsDown?: boolean;
}

export class FakePayer implements PayerPort {
  readonly leases: FakeLease[] = [];
  readonly createRequests: PayerCreateRequest[] = [];
  /** Provider for the n-th create (1-based). */
  providerFor: (n: number) => string = (n) => `provider-${n}`;
  /** Inject a failure for the n-th create call; the lease is NOT created. */
  createFault?:
    | ((n: number, req: PayerCreateRequest) => PayerError | undefined)
    | undefined;
  /** After this create succeeds the response is lost (throws ambiguous) though the lease exists. */
  loseResponseOn?: ((n: number) => boolean) | undefined;
  failDelete = false;
  observeThrows = false;
  /** Lets a test mark leases serving broken before the sequencer reaches them. */
  onLease?: ((l: FakeLease) => void) | undefined;
  private calls = 0;
  constructor(readonly events: string[]) {}

  private resource(l: FakeLease): PayerResource {
    return {
      externalName: l.dseq,
      state: l.state,
      endpoints: l.endpoints,
      providerAccount: l.provider,
    };
  }
  byDseq(dseq: string): FakeLease {
    const l = this.leases.find((x) => x.dseq === dseq);
    if (!l) throw new Error(`no lease ${dseq}`);
    return l;
  }
  liveLeases(): FakeLease[] {
    return this.leases.filter((l) => l.state === "active");
  }
  async create(req: PayerCreateRequest): Promise<PayerResource> {
    this.createRequests.push(req);
    const existing = this.leases.find((l) => l.cogniKey === req.cogniKey);
    if (existing) return this.resource(existing);
    const n = ++this.calls;
    const fault = this.createFault?.(n, req);
    if (fault) throw fault;
    const svc = req.spec.services[0];
    if (!svc) throw new Error("spec has no service");
    const provider = this.providerFor(n);
    const dseq = String(1000 + n);
    const host = svc.expose?.[0]?.hosts?.[0];
    const lease: FakeLease = {
      dseq,
      cogniKey: req.cogniKey,
      provider,
      state: "active",
      endpoints: host
        ? [`ingress-${dseq}.${provider}.example`, host]
        : [`tcp://${provider}.example:${31000 + n}`],
      env: { ...(svc.env ?? {}) },
    };
    this.leases.push(lease);
    this.onLease?.(lease);
    this.events.push(`payer.create:${dseq}`);
    if (this.loseResponseOn?.(n))
      throw new PayerError("outcome_unknown", "response lost", true);
    return this.resource(lease);
  }
  async observe(req: {
    cogniKey: string;
    externalName?: string;
  }): Promise<{ found: boolean; resource?: PayerResource }> {
    if (this.observeThrows)
      throw new PayerError("network", "observe down", false);
    const l = this.leases.find(
      (x) => x.cogniKey === req.cogniKey || x.dseq === req.externalName
    );
    return l ? { found: true, resource: this.resource(l) } : { found: false };
  }
  async delete(req: { cogniKey: string; externalName: string }): Promise<void> {
    this.events.push(`payer.delete:${req.externalName}`);
    if (this.failDelete)
      throw new PayerError("provider_unavailable", "delete failed", false);
    this.byDseq(req.externalName).state = "closed";
  }
}

export class FakeChain implements ChainTruthPort {
  readonly override = new Map<
    string,
    "active" | "closed" | "insufficient_funds" | "unknown"
  >();
  constructor(private readonly payer: FakePayer) {}
  async deploymentState(
    externalName: string
  ): Promise<"active" | "closed" | "insufficient_funds" | "unknown"> {
    return (
      this.override.get(externalName) ??
      (this.payer.byDseq(externalName).state === "closed" ? "closed" : "active")
    );
  }
}

export class FakeDns implements DnsRecordsPort {
  readonly records = new Map<string, DnsRecord>();
  readonly ops: string[] = [];
  /** Tamper with the next readback (simulates Cloudflare disagreeing with the write). */
  corruptReadback = false;
  private seq = 0;
  constructor(private readonly events: string[]) {}
  seed(rec: Omit<DnsRecord, "id">): DnsRecord {
    const r = { ...rec, id: `rec-${++this.seq}` };
    this.records.set(r.id, r);
    return r;
  }
  async findByName(name: string): Promise<readonly DnsRecord[]> {
    return [...this.records.values()].filter((r) => r.name === name);
  }
  async create(input: DnsRecordInput): Promise<DnsRecord> {
    this.ops.push(`create:${input.name}->${input.content}`);
    this.events.push("dns.create");
    return this.seed({ ...input });
  }
  async update(id: string, input: DnsRecordInput): Promise<DnsRecord> {
    this.ops.push(`update:${input.name}->${input.content}`);
    this.events.push("dns.update");
    const r = { ...input, id };
    this.records.set(id, r);
    return r;
  }
  async read(id: string): Promise<DnsRecord> {
    const r = this.records.get(id);
    if (!r) throw new Error(`no record ${id}`);
    if (this.corruptReadback) return { ...r, proxied: false };
    return r;
  }
}

export class FakeProbe implements ProbePort {
  /** public reads served by the CURRENT edge target; the first N after a move still hit the old one. */
  publicStaleReads = 0;
  private staleLeft = 0;
  private lastTarget: string | undefined;
  readonly publicReads: string[] = [];
  constructor(
    private readonly payer: FakePayer,
    private readonly dns: FakeDns,
    private readonly events: string[]
  ) {}

  private leaseByIngress(ingress: string): FakeLease | undefined {
    return this.payer.leases.find((l) => l.endpoints.includes(ingress));
  }
  private serve(l: FakeLease | undefined, path: string): HttpResult {
    if (!l || l.state === "closed" || l.down)
      return { status: 0, body: "", ms: 1, error: "ECONNREFUSED" };
    if (path.startsWith("/readyz"))
      return l.notReady
        ? { status: 503, body: '{"status":"no"}', ms: 1 }
        : { status: 200, body: '{"status":"ok"}', ms: 1 };
    const sha = l.serveSha ?? l.env.RELEASE_SHA ?? "none";
    return { status: 200, body: JSON.stringify({ buildSha: sha }), ms: 1 };
  }
  async hostRouted(
    ingressHost: string,
    _host: string,
    path: string
  ): Promise<HttpResult> {
    return this.serve(this.leaseByIngress(ingressHost), path);
  }
  async publicDoh(host: string, path: string): Promise<HttpResult> {
    const rec = [...this.dns.records.values()].find((r) => r.name === host);
    if (!rec)
      return { status: 0, body: "", ms: 1, error: "doh: no A record yet" };
    if (rec.content !== this.lastTarget) {
      this.lastTarget = rec.content;
      this.staleLeft = this.publicStaleReads;
    }
    let target = rec.content;
    if (this.staleLeft > 0) {
      this.staleLeft--;
      target = this.stale ?? rec.content;
    }
    const r = this.serve(this.leaseByIngress(target), path);
    this.publicReads.push(`${target}:${r.status}`);
    this.events.push("public.read");
    return r;
  }
  /** The target served while an edge move has not converged. */
  stale: string | undefined;
  async tcpTls(host: string, port: number): Promise<boolean> {
    const l = this.payer.leases.find((x) =>
      x.endpoints.includes(`tcp://${host}:${port}`)
    );
    return !!l && l.state === "active" && !l.tlsDown;
  }
}

export function canaryDb(
  overrides: Partial<NodeWorkloadSpec> = {}
): NodeWorkloadSpec {
  return {
    name: "canary-db",
    kind: "state",
    image: `postgres:16@${DIGEST}`,
    command: ["bash", "-c", "echo db"],
    port: 5432,
    expose: { tcp: { global: true } },
    cpu: 0.5,
    memoryMi: 512,
    storageMi: 512,
    persistent: { sizeMi: 2048, mountPath: "/var/lib/postgresql/data" },
    env: { PGDATA: "/var/lib/postgresql/data/pgdata" },
    bindings: [],
    exclusive: false,
    ...overrides,
  } as NodeWorkloadSpec;
}

export function canaryApp(
  overrides: Partial<NodeWorkloadSpec> = {}
): NodeWorkloadSpec {
  return {
    name: "canary",
    kind: "app",
    image: `postgres:16-alpine@${DIGEST}`,
    command: ["sh", "-c", "echo app"],
    port: 8080,
    expose: { http: { host: PUBLIC_HOST } },
    cpu: 0.25,
    memoryMi: 256,
    storageMi: 256,
    env: {},
    bindings: [{ env: "DATABASE_URL", workload: "canary-db" }],
    exclusive: false,
    health: { version: "/version", ready: "/readyz" },
    ...overrides,
  } as NodeWorkloadSpec;
}
