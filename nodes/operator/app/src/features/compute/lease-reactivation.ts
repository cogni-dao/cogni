// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/lease-reactivation`
 * Purpose: Derive the lease replacement ordinal a RE-activated (node, environment) must be
 *   authored with (story.5039 PR-B). The actuator's idempotence key is spent forever once a
 *   lease under it settles terminally, so re-adding an env whose ledger already holds a terminal
 *   receipt at the current generation MUST author a bumped `lease_generation` cell — else the
 *   next reconcile answers with a refusal and the workload never comes up.
 * Scope: Pure generation and terminal-repair policy plus bounded read-only qualification through
 *   the existing wallet-scoped capability. No Git or paid-provider mutation.
 *   Existing-lane repair requires exact base/recovery identity and complete native closure.
 *   Unknown/live/in-flight/retained evidence never advances an existing lane.
 * Invariants:
 *   - GENERATION_IS_NOT_CALLER_INPUT still HOLDS (node-lease-generation.ts): the REST body never
 *     carries a generation. This function derives it from the LEDGER — durable receipt evidence,
 *     not caller choice — and the env verb passes the derived value into the catalog writer.
 *   - NOTHING_BUMPS_IMPLICITLY still HOLDS: the derived value becomes real only as a reviewed,
 *     merged catalog commit (the env verb's PR). The verb AUTHORS the commit FROM receipt
 *     evidence; it bypasses neither the review nor the commit — no running system increments a
 *     generation on its own, and the catalog cell remains the only thing the Composition reads.
 *   - TERMINAL_SPENDS_THE_GENERATION (task.5132): every receipt in a TERMINAL state
 *     (`released` | `failed`) forces the next generation past it. `released` bound a handle, so
 *     its key is spent forever (HANDLE_IS_WRITE_ONCE). `failed` is terminal FROM THIS PATH too:
 *     the ledger's failed-no-handle re-claim (bug.5192) requires the SAME `compositeUid`, and an
 *     env-verb ADD recreates the XR with a NEW composite — so the recreated workload presenting
 *     the old generation's key hits the identity check, not the re-claim. Observed live
 *     2026-09-18T03:01:34Z: a terminally failed gen-0 receipt (ledgerState=failed, identity-bound
 *     to dead composite 02727e4b) while this derivation still answered 0 made the recreated XR
 *     present `xcw:cogni-candidate-a:4b06359a-…:0` and the actuator correctly refused it with
 *     `akash_tx_identity_conflict`.
 *   - LIVE_KEEPS_ITS_GENERATION: a non-terminal receipt never bumps. `preparing` is
 *     mid-transaction and proves nothing yet; `allocated` is a LIVE paid lease — it PINS the
 *     derived generation AT its own (so the catalog re-states the key that can replay/adopt the
 *     running resource) but bumping past it would abandon a billing lease and double-pay.
 * Side-effects: read-only ledger/native I/O in qualifyTerminalLaneRepair; pure decisions otherwise.
 * Links: src/features/compute/node-lease-generation.ts (the read twin),
 *   src/ports/akash-tx.port.ts (AkashTxAllocationRecord), story.5039, bug.5192, task.5132
 * @public
 */

import { parse as parseYaml } from "yaml";
import type { AkashTxAllocationRecord } from "@/ports";
import { githubOwnerFromSourceRepo } from "@/shared/node-app-scaffold/gens/catalog";
import { writerFor } from "@/shared/node-registry/crossplane-control-plane";
import { controlEnvFor } from "@/shared/node-registry/placement";
import type { AkashNativeObservation } from "@/types/akash-native-state";
import { resolveNodeIsolatedServices } from "./node-isolated-services";

/**
 * The generation a fresh activation of this (node, environment) must state in the catalog.
 *
 * `max` over: the catalog's own generation; `generation + 1` for every TERMINAL receipt
 * (`released` | `failed` — keys that can never be reused by a recreated composite,
 * TERMINAL_SPENDS_THE_GENERATION); and `generation` (no +1) for every LIVE `allocated` receipt
 * (LIVE_KEEPS_ITS_GENERATION). An add with an empty ledger stays at the catalog's generation —
 * 0 is byte-identical to a birth row.
 *
 * The receipt's replacement ordinal is the final component of `cogniKey`. It must never be
 * confused with `identity.compositeGeneration`: that field is Kubernetes `metadata.generation`,
 * a mutable reconciliation revision which can advance thousands of times while one paid lease
 * keeps the same idempotence key. The Crossplane composition authors keys as
 * `xcw:<namespace>:<node-id>:<leaseGeneration>`, so the suffix is the durable generation evidence.
 */
/**
 * The generation a REPLACEMENT of this (node, environment) must state in the catalog.
 *
 * WHY THIS IS NOT `requiredLeaseGeneration` (story.5050). That function implements
 * LIVE_KEEPS_ITS_GENERATION: a live `allocated` receipt re-states ITS generation so an activation
 * can replay/adopt the running resource instead of abandoning a billing lease. That is correct for
 * reactivation and WRONG for replacement. A placement change cannot adopt the running lease —
 * Akash refuses in-place placement change, so the requirement only binds on a lease minted fresh.
 * Re-stating the live generation would leave the catalog cell unchanged and the verb would succeed
 * while doing nothing, which is the "a verb that succeeds and does nothing is BROKEN" failure.
 *
 * So this bumps past EVERY generation the ledger has seen, live ones included.
 *
 * REPLACEMENT_ABANDONS_A_PAID_LEASE: that is the deliberate cost, and callers MUST surface the
 * displaced `allocated` receipts to the requester rather than silently orphan them — an
 * unclosed lease bills invisibly (bug.5189). This function reports the generation; enumerating
 * the money is the caller's job, exactly as the env REMOVE verb already does.
 */
export function replacementLeaseGeneration(input: {
  readonly catalogGeneration: number;
  readonly receipts: readonly AkashTxAllocationRecord[];
}): number {
  let required = input.catalogGeneration;
  for (const receipt of input.receipts) {
    const match = /^xcw:.+:(0|[1-9]\d*)$/.exec(receipt.cogniKey);
    const generation = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(generation) || generation > 1_000_000) {
      throw new Error(
        `[lease-reactivation] receipt ${receipt.receiptId} has no valid lease generation suffix`
      );
    }
    // `preparing` is mid-transaction: not evidence, and NOT safe to leapfrog either — a key being
    // minted right now must not be re-presented, so it counts the same as a spent one.
    required = Math.max(required, generation + 1);
  }
  return required;
}

export function requiredLeaseGeneration(input: {
  readonly catalogGeneration: number;
  readonly receipts: readonly AkashTxAllocationRecord[];
}): number {
  let required = input.catalogGeneration;
  for (const receipt of input.receipts) {
    const match = /^xcw:.+:(0|[1-9]\d*)$/.exec(receipt.cogniKey);
    const generation = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(generation) || generation > 1_000_000) {
      throw new Error(
        `[lease-reactivation] receipt ${receipt.receiptId} has no valid lease generation suffix`
      );
    }
    if (receipt.state === "released" || receipt.state === "failed") {
      // Terminal: this generation's key is spent — the next activation needs the one after it.
      required = Math.max(required, generation + 1);
    } else if (receipt.state === "allocated") {
      // Live paid lease: the activation must re-state ITS generation, never leapfrog it.
      required = Math.max(required, generation);
    }
    // `preparing` is mid-transaction — not evidence in either direction.
  }
  return required;
}

/** Exact application family. Recovery attempt is never a replacement base. */
export function parseAppLeaseKey(
  key: string,
  subject: { readonly namespace: string; readonly nodeId: string }
): { base: number; attempt: number } {
  const fields = /^xcw:([^:]+):([^:]+):(0|[1-9]\d*)(?::recover:([1-3]))?$/.exec(
    key
  );
  if (
    !fields ||
    fields[1] !== subject.namespace ||
    fields[2] !== subject.nodeId ||
    Number(fields[3]) > 1_000_000
  ) {
    throw repairRefusal("repair_identity_conflict");
  }
  return { base: Number(fields[3]), attempt: Number(fields[4] ?? 0) };
}

function repairRefusal(
  code: string,
  status = 409
): Error & { code: string; status: number } {
  return Object.assign(new Error(code), { code, status });
}

export interface TerminalLaneSubject {
  readonly nodeId: string;
  readonly slug: string;
  readonly environment: string;
  readonly namespace: string;
  readonly catalogGeneration: number;
  readonly accountId: string;
}

/** Pure qualification; observations are supplied only by a fresh capability read in this operation. */
export function evaluateTerminalLaneRepair(input: {
  readonly subject: TerminalLaneSubject;
  readonly receipts: readonly AkashTxAllocationRecord[];
  readonly historyComplete: boolean;
  readonly native: Readonly<Record<string, AkashNativeObservation>>;
}):
  | { kind: "no_changes" }
  | {
      kind: "repair";
      generation: number;
      currentKey: string;
      handle: string;
      receiptId: string;
      compositeUid: string;
    } {
  const { subject, receipts, native } = input;
  if (
    !input.historyComplete ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      subject.nodeId
    ) ||
    !subject.accountId ||
    !Number.isSafeInteger(subject.catalogGeneration) ||
    subject.catalogGeneration < 0 ||
    subject.catalogGeneration > 1_000_000
  )
    throw repairRefusal("generation_evidence_unavailable", 503);
  const keys = new Set<string>();
  const handles = new Set<string>();
  const receiptIds = new Set<string>();
  const composites = new Map<number, string>();
  const parsed = receipts.map((receipt) => {
    const key = parseAppLeaseKey(receipt.cogniKey, subject);
    if (
      keys.has(receipt.cogniKey) ||
      !receipt.receiptId ||
      receiptIds.has(receipt.receiptId) ||
      !["preparing", "allocated", "released", "failed"].includes(
        receipt.state
      ) ||
      receipt.identity.nodeId !== subject.nodeId ||
      !receipt.identity.compositeUid ||
      !Number.isSafeInteger(receipt.identity.compositeGeneration) ||
      receipt.identity.compositeGeneration < 1 ||
      receipt.environment !== subject.environment ||
      receipt.workload !== subject.slug
    )
      throw repairRefusal("repair_identity_conflict");
    keys.add(receipt.cogniKey);
    receiptIds.add(receipt.receiptId);
    const composite = composites.get(key.base);
    if (composite && composite !== receipt.identity.compositeUid)
      throw repairRefusal("repair_identity_conflict");
    composites.set(key.base, receipt.identity.compositeUid);
    if (
      receipt.retentionPolicy === "retain" ||
      receipt.appliedDatabaseCellBinding?.length
    )
      throw repairRefusal("repair_retained_data");
    return { receipt, ...key };
  });
  const current = parsed.find(
    (row) => row.base === subject.catalogGeneration && row.attempt === 0
  );
  // A newly merged unused target is pending, never permission to skip another key.
  if (!current && parsed.every((row) => row.base < subject.catalogGeneration))
    return { kind: "no_changes" };
  if (!current) throw repairRefusal("repair_current_receipt_unavailable");
  if (
    (current.receipt.state !== "released" &&
      current.receipt.state !== "failed") ||
    !current.receipt.externalName
  )
    throw repairRefusal("repair_current_not_terminal");
  for (const { receipt, base, attempt } of parsed) {
    if (
      receipt.state === "preparing" ||
      (base === current.base &&
        receipt.state !== "released" &&
        receipt.state !== "failed")
    )
      throw repairRefusal("repair_allocation_unresolved");
    if (
      base === current.base &&
      receipt.identity.compositeUid !== current.receipt.identity.compositeUid
    )
      throw repairRefusal("repair_identity_conflict");
    for (let n = 0; n < attempt; n++) {
      if (!parsed.some((row) => row.base === base && row.attempt === n))
        throw repairRefusal("repair_recovery_history_incomplete");
    }
    const handle = receipt.externalName;
    if (!handle) {
      if (
        base === current.base ||
        receipt.state !== "failed" ||
        receipt.allocationCursor
      )
        throw repairRefusal("repair_allocation_unresolved");
      continue;
    }
    if (handles.has(handle)) throw repairRefusal("repair_identity_conflict");
    handles.add(handle);
    if (!/^[1-9]\d*$/.test(handle) || BigInt(handle) > 18446744073709551615n)
      throw repairRefusal("repair_identity_conflict");
    const proof = native[handle];
    if (
      !proof ||
      proof.errorCode !== null ||
      !proof.source ||
      !proof.observedAt ||
      !proof.deploymentObservedAt ||
      proof.deploymentCoverage !== "complete" ||
      proof.deploymentState === null ||
      proof.leaseCoverage !== "complete"
    )
      throw repairRefusal("generation_evidence_unavailable", 503);
    if (proof.deploymentState !== "closed")
      throw repairRefusal("repair_native_not_closed");
    if (
      proof.leaseStates.some(
        (lease) =>
          lease.id.owner !== subject.accountId ||
          lease.id.dseq !== handle ||
          !lease.id.provider ||
          !Number.isSafeInteger(lease.id.gseq) ||
          !Number.isSafeInteger(lease.id.oseq) ||
          !Number.isSafeInteger(lease.id.bseq) ||
          lease.id.gseq < 1 ||
          lease.id.oseq < 1 ||
          lease.id.bseq < 0 ||
          (base === current.base
            ? lease.state !== "closed"
            : lease.state !== "closed" && lease.state !== "insufficient_funds")
      )
    )
      throw repairRefusal("repair_native_not_closed");
    if (
      receipt.providerAccount &&
      !proof.leaseStates.some(
        (lease) => lease.id.provider === receipt.providerAccount
      )
    )
      throw repairRefusal("repair_supplier_conflict");
  }
  const generation = Math.max(
    subject.catalogGeneration,
    ...parsed.map((row) => row.base + 1)
  );
  if (generation > 1_000_000)
    throw repairRefusal("repair_generation_exhausted");
  return {
    kind: "repair",
    generation,
    currentKey: current.receipt.cogniKey,
    receiptId: current.receipt.receiptId,
    handle: current.receipt.externalName,
    compositeUid: current.receipt.identity.compositeUid,
  };
}

/** Wiring-neutral read seam: reuse the existing wallet-scoped capability and its native reader. */
export async function qualifyTerminalLaneRepair(input: {
  readonly catalog: string;
  readonly nodeId: string;
  readonly slug: string;
  readonly environment: "candidate-a" | "preview" | "production";
  readonly accountId: string | undefined;
  readonly hostingEnv: string | undefined;
  readonly fleetControlEnv: string | undefined;
  readonly leaseRead:
    | {
        listReceipts(input: {
          nodeId: string;
          environment: string;
          limit: number;
        }): Promise<readonly AkashTxAllocationRecord[]>;
        readNativeStates(input: {
          dseqs: readonly string[];
        }): Promise<Readonly<Record<string, AkashNativeObservation>>>;
      }
    | undefined;
}): Promise<{
  generation: number;
  evidence: {
    subject: TerminalLaneSubject;
    currentKey: string;
    handle: string;
    receiptId: string;
    compositeUid: string;
    receipts: readonly {
      cogniKey: string;
      receiptId: string;
      nodeId: string;
      compositeUid: string;
      state: string;
      externalName?: string;
      providerAccount?: string;
    }[];
    native: Readonly<Record<string, AkashNativeObservation>>;
  };
} | null> {
  let parsedCatalog: unknown;
  try {
    parsedCatalog = parseYaml(input.catalog);
  } catch {
    throw repairRefusal("repair_policy_invalid", 422);
  }
  const row = parsedCatalog as {
    name?: string;
    node_id?: string;
    source_repo?: string;
    envs?: string[];
    deployment_provider?: Record<string, string>;
    compute_api?: Record<string, string>;
    lease_generation?: Record<string, number>;
  };
  if (!row || typeof row !== "object")
    throw repairRefusal("repair_policy_invalid", 422);
  // Existing k3s membership is a no-op. Contradictory/unsupported policy is not.
  const maps = [row.deployment_provider, row.compute_api, row.lease_generation];
  if (
    row.name !== input.slug ||
    !Array.isArray(row.envs) ||
    !row.envs.includes(input.environment) ||
    maps.some(
      (map) =>
        map !== undefined &&
        (!map || typeof map !== "object" || Array.isArray(map))
    )
  )
    throw repairRefusal("repair_policy_invalid", 422);
  if (row.source_repo !== undefined) {
    if (typeof row.source_repo !== "string" || !row.source_repo)
      throw repairRefusal("repair_policy_invalid", 422);
    try {
      githubOwnerFromSourceRepo(row.source_repo);
    } catch {
      throw repairRefusal("repair_policy_invalid", 422);
    }
  }
  const provider = row.deployment_provider?.[input.environment];
  const authority = row.compute_api?.[input.environment];
  const generation = row.lease_generation?.[input.environment];
  if (
    provider === "k3s" ||
    (provider === undefined && row.source_repo === undefined)
  ) {
    if (authority !== undefined || generation !== undefined)
      throw repairRefusal("repair_policy_invalid", 422);
    return null;
  }
  if (
    provider !== "akash" ||
    authority !== "crossplane" ||
    typeof row.source_repo !== "string" ||
    !row.source_repo ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      row.node_id ?? ""
    ) ||
    !Number.isSafeInteger(generation) ||
    generation === undefined ||
    generation < 0 ||
    generation > 1_000_000
  )
    throw repairRefusal("repair_policy_invalid", 422);
  let writer: ReturnType<typeof writerFor>;
  try {
    writer = writerFor(
      input.environment,
      githubOwnerFromSourceRepo(row.source_repo)
    );
  } catch {
    throw repairRefusal("repair_policy_invalid", 422);
  }
  if (!writer) throw repairRefusal("repair_policy_invalid", 422);
  const control = controlEnvFor(
    input.environment,
    "akash",
    input.fleetControlEnv
  );
  if (
    row.node_id !== input.nodeId ||
    writer.cluster !== input.hostingEnv ||
    control !== input.hostingEnv
  )
    throw repairRefusal("repair_subject_conflict");
  if (!input.leaseRead || !input.accountId?.trim())
    throw repairRefusal("generation_evidence_unavailable", 503);
  const subject: TerminalLaneSubject = {
    nodeId: input.nodeId,
    slug: input.slug,
    environment: input.environment,
    namespace: `cogni-${input.environment}`,
    catalogGeneration: generation,
    accountId: input.accountId.trim(),
  };
  const all = await input.leaseRead
    .listReceipts({
      nodeId: input.nodeId,
      environment: input.environment,
      limit: 51,
    })
    .catch(() => {
      throw repairRefusal("generation_evidence_unavailable", 503);
    });
  if (all.length >= 51)
    throw repairRefusal("generation_evidence_unavailable", 503);
  let isolated: ReturnType<typeof resolveNodeIsolatedServices>;
  try {
    isolated = resolveNodeIsolatedServices({
      catalog: row,
      environment: input.environment,
    });
  } catch {
    throw repairRefusal("repair_policy_invalid", 422);
  }
  const receipts = all.filter(
    (receipt) =>
      !isolated.some((service) => {
        try {
          parseAppLeaseKey(receipt.cogniKey, {
            namespace: subject.namespace,
            nodeId: `${input.nodeId}-${service.service}`,
          });
          return (
            receipt.identity.nodeId === input.nodeId &&
            receipt.environment === input.environment
          );
        } catch {
          return false;
        }
      })
  );
  const native = await input.leaseRead
    .readNativeStates({
      dseqs: [
        ...new Set(
          receipts.flatMap((receipt) =>
            receipt.externalName ? [receipt.externalName] : []
          )
        ),
      ],
    })
    .catch(() => {
      throw repairRefusal("generation_evidence_unavailable", 503);
    });
  const result = evaluateTerminalLaneRepair({
    subject,
    receipts,
    native,
    historyComplete: true,
  });
  if (result.kind !== "repair") return null;
  return {
    generation: result.generation,
    evidence: {
      subject,
      currentKey: result.currentKey,
      handle: result.handle,
      receiptId: result.receiptId,
      compositeUid: result.compositeUid,
      receipts: receipts.map((receipt) => ({
        cogniKey: receipt.cogniKey,
        receiptId: receipt.receiptId,
        nodeId: receipt.identity.nodeId,
        compositeUid: receipt.identity.compositeUid,
        state: receipt.state,
        ...(receipt.externalName ? { externalName: receipt.externalName } : {}),
        ...(receipt.providerAccount
          ? { providerAccount: receipt.providerAccount }
          : {}),
      })),
      native,
    },
  };
}
