// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/capabilities/compute`
 * Purpose: Compute-substrate capability — the typed control plane over the compute provider account(s) that fund the node network's workloads: balance/cost awareness (read half) + container-workload provisioning (write half, task.5044).
 * Scope: Defines ComputeResourcePort (balances + optional provision/status/release) and the provider-agnostic ComputeBalance/ProvisionSpec/ProvisionOutput types. Does NOT implement transport or settle payment.
 * Invariants:
 *   - CAPABILITY_INJECTION: Implementation injected at bootstrap, not imported.
 *   - PROVIDER_AGNOSTIC: Types speak uniform units (currency + remaining, vCPU/Mi, image + ports),
 *     never provider units. Cherry credit/promo shape, Akash SDL/uakt/escrow/bids — none of it
 *     escapes the adapter.
 *   - ADAPTER_SWAPPABLE: CherryComputeAdapter (read-only) and AkashComputeAdapter (read + write)
 *     are 1:1 swappable; the interface never names a provider.
 *   - WRITE_HALF_OPTIONAL: provision/status/release are optional members — adapters that cannot
 *     deploy workloads (Cherry v0, the stub) simply omit them; callers feature-detect and surface
 *     `compute_write_unsupported`. settle() (Cosmos/axlUSDC self-custody) remains deferred: the
 *     v1 write path bills a managed account in USD, so there is nothing to settle on-chain yet
 *     (vNext: pass-through billing per spawning account + programmatic crypto funding).
 * Side-effects: none (interface only)
 * Links: docs/spec/cicd-platform-boundary.md § "The next layer: a typed operator control plane",
 *   story.5011 (preview balance-suspension incident), task.5044 (Akash write half),
 *   sibling of ./deploy DeployCapability.
 * @public
 */

/**
 * Provider-agnostic balance for one compute provider account.
 *
 * `remaining` is expressed in `currency` major units (ISO 4217). `provider`/`accountId`
 * are opaque labels for observability + alert routing — callers MUST NOT branch on them
 * (that would re-leak provider specifics the adapter exists to contain).
 */
export interface ComputeBalance {
  /** Opaque provider label, e.g. "cherry" / "akash". For labeling, never branched on. */
  readonly provider: string;
  /** Opaque provider account/team identifier. */
  readonly accountId: string;
  /** ISO 4217 currency code of `remaining`, e.g. "EUR" / "USD". */
  readonly currency: string;
  /** Remaining balance in `currency` major units. */
  readonly remaining: number;
  /** ISO 8601 timestamp the balance was read. */
  readonly asOf: string;
  /**
   * Estimated days of runway at current burn, or `null` when burn-rate is unknown
   * (v0 reads a single balance with no usage history, so this is null until a
   * burn-rate read lands).
   */
  readonly estimatedDaysRemaining: number | null;
}

/**
 * One container service inside a provisioned workload — the provider-agnostic unit the
 * adapter translates (to an Akash SDL service, a k8s Deployment, …). Image refs must be
 * pullable by the provider (public registry for v1).
 */
export interface ProvisionServiceSpec {
  /** DNS-safe service name, unique within the spec. */
  readonly name: string;
  /** Fully-qualified image ref (e.g. `ghcr.io/cogni-dao/toks4:sha-<sha>`). */
  readonly image: string;
  /** Plain env vars baked into the workload. Secrets included here reach the provider — caller's call. */
  readonly env?: Readonly<Record<string, string>>;
  /** Optional container command override. */
  readonly command?: readonly string[];
  /** Optional arguments passed to the image entrypoint or command. */
  readonly args?: readonly string[];
  /** Fractional vCPU units (e.g. 0.5). */
  readonly cpuUnits: number;
  /** Memory in Mi. */
  readonly memoryMi: number;
  /** Ephemeral storage in Mi. */
  readonly storageMi: number;
  /** Ports to expose. Omitted → service is internal-only (reachable by sibling services). */
  readonly expose?: readonly {
    /** Container port. */
    readonly port: number;
    /** Externally-served port (80 → provider HTTP ingress). */
    readonly as: number;
    /** True → public ingress; false → reachable only by sibling services in this spec. */
    readonly global: boolean;
    /** Custom hostnames the ingress should accept (CNAME targets), when global. */
    readonly hosts?: readonly string[];
  }[];
}

/** A complete provisionable workload: one or more co-located services. */
/**
 * Hard constraint on WHERE a workload may be placed, expressed in provider-agnostic units
 * (ISO 3166-1 alpha-2), never provider units — each adapter maps it onto its own marketplace.
 *
 * This is a REQUIREMENT, not a preference. It exists because a workload can have an outbound
 * dependency that geo-fences by IP, and a latency-driven placement preference pulls in the
 * opposite direction (co-locating near the shared substrate lands in jurisdictions a
 * geo-fenced API refuses). Preference ranks; this refuses.
 *
 * REQUIRED_FAILS_CLOSED: a candidate outside the set, or one whose country an adapter cannot
 * determine, is REFUSED. A requirement that cannot be evaluated is not satisfied. This
 * deliberately inverts the fail-open rule that governs placement *preferences*.
 *
 * NOT_A_GUARANTEE: country data describes a provider's advertised/ingress identity, which is
 * measurably not the same as the egress identity its workload presents to a third party
 * (two Akash providers in different advertised countries have shared one egress NAT). This
 * narrows the candidate pool; only the workload's own outbound probe proves reachability.
 */
export interface ProvisionPlacement {
  /**
   * Country codes the workload MAY be placed in. Non-empty = hard requirement.
   * Omit the field entirely for unconstrained placement; an empty array is not a valid
   * way to say "anywhere" (it would refuse everything).
   */
  readonly requiredCountryCodes: readonly string[];
}

export interface ProvisionSpec {
  /** Workload label for observability (e.g. the node slug). */
  readonly name: string;
  readonly services: readonly ProvisionServiceSpec[];
  /** Hard placement constraints. Absent = unconstrained. */
  readonly placement?: ProvisionPlacement;
}

/** Lifecycle state of a provisioned workload, uniform across providers. */
export type ProvisionState = "pending" | "active" | "closed" | "unknown";

/**
 * Provider-agnostic view of one provisioned workload. `leaseId` is opaque — callers persist
 * and echo it, never parse it (Akash dseq, k8s namespace, … stay inside the adapter).
 */
export interface ProvisionOutput {
  /** Opaque provider label, e.g. "akash". For labeling, never branched on. */
  readonly provider: string;
  /** Opaque workload handle for status/release calls. */
  readonly leaseId: string;
  readonly state: ProvisionState;
  /** Public URIs serving the workload's global exposes; empty until the provider reports them. */
  readonly endpoints: readonly string[];
}

/**
 * Compute-substrate capability.
 *
 * `balances()` is the universal read half. The write half (`provision`/`status`/`release`) is
 * OPTIONAL per WRITE_HALF_OPTIONAL — implemented by workload-capable adapters (Akash Console,
 * task.5044); `settle()` (Cosmos multisig / axlUSDC self-custody) remains deferred until the
 * crypto-funded path lands.
 */
export interface ComputeResourcePort {
  /**
   * Read the current balance of every configured compute provider account.
   *
   * Returns one entry per account so the awareness surface (scheduled emitter + dashboard)
   * covers each provider uniformly. Returns an empty array when no provider is configured.
   */
  balances(): Promise<readonly ComputeBalance[]>;

  /**
   * Deploy a workload on provider compute. Resolves once the lease is CREATED — the returned
   * state is commonly still `pending` and `endpoints` empty; poll `status()` until the
   * provider reports serving URIs. `env` is a placement/labeling hint (e.g. "candidate-a"),
   * not a provider region.
   */
  provision?(p: { env: string; spec: ProvisionSpec }): Promise<ProvisionOutput>;

  /** Read the current state + endpoints of a provisioned workload. */
  status?(p: { leaseId: string }): Promise<ProvisionOutput>;

  /** Tear down a provisioned workload; unspent escrow returns to the account balance. */
  release?(p: { leaseId: string }): Promise<void>;
}
