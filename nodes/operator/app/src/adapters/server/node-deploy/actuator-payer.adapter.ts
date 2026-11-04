// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/actuator-payer.adapter`
 * Purpose: ActuatorPayer — the PRODUCTION `PayerPort`. Calls the private `akash-tx-actuator` over the
 *   v1 wire (create, observe, delete) so the actuator stays the ONLY paid Akash writer (task.5400).
 * Scope: HTTP + code mapping only. The sequencer owns every policy decision.
 * Invariants:
 *   - ACTUATOR_IS_THE_ONLY_PAYER: this process holds the actuator BEARER token only; never the
 *     Console API key, never a wallet.
 *   - AMBIGUITY_IS_EXPLICIT: a create that timed out, lost its response or got a 5xx/409-recoverable
 *     answer is thrown as `PayerError.ambiguous`; the sequencer resolves it through `observe(cogniKey)`
 *     and never blindly repeats the paid call.
 *   - DEFINITIVE_IS_PROVEN (bug.5569): a create `provider_rejected` is `definitive` (nothing bills
 *     under the key) unless the actuator says its rollback close is UNVERIFIED.
 *   - NO_SECRETS_IN_ERRORS: error text is the actuator's own non-secret `code` + `message`.
 * Side-effects: IO (HTTP POST to the cluster-private actuator)
 * Links: contracts/compute.akash-tx.v1.contract.ts, features/compute/akash-tx/akash-tx-http.ts
 * @internal
 */

import {
  type PayerCreateRequest,
  PayerError,
  type PayerErrorCode,
  type PayerPort,
  type PayerResource,
} from "@/ports";

export interface ActuatorPayerConfig {
  /** e.g. `http://akash-tx-actuator:8080` */
  readonly actuatorUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  /** Create may take minutes (bids + lease); observe/delete are short. */
  readonly createTimeoutMs?: number;
  readonly readTimeoutMs?: number;
}

/** Mirrors the wire contract's `excludeProviders` item pattern. */
const PROVIDER_ACCOUNT = /^akash1[0-9a-z]{38}$/u;

const KNOWN_CODES: ReadonlySet<string> = new Set<PayerErrorCode>([
  "invalid_request",
  "unauthorized",
  "not_found",
  "wallet_allocation_blocked",
  "allocation_unresolved",
  "allocation_ambiguous",
  "allocation_rolled_back",
  "provider_rejected",
  "placement_violated_by_incumbent",
  "identity_conflict",
  "provider_unavailable",
  "outcome_unknown",
  "ledger_unavailable",
]);

/** Codes after which a paid lease MAY exist under the key (resolve through observe, never re-create). */
const AMBIGUOUS: ReadonlySet<string> = new Set([
  "allocation_unresolved",
  "allocation_ambiguous",
  "allocation_rolled_back",
  "provider_unavailable",
  "outcome_unknown",
  "ledger_unavailable",
  "network",
]);

/**
 * The ONE `provider_rejected` that may leave something billing: the actuator opened a deployment,
 * then could not prove its close (`akash-compute.adapter.ts` createAndLease: "(deployment N close
 * UNVERIFIED)"). Every other `provider_rejected` on create was refused before a deployment existed
 * (caller allowlist, settled key, Console 4xx on the deployment POST) or closed and read back
 * closed ("(deployment N closed, escrow refunding)", `rolledBackDseq`): definitive (bug.5569).
 */
const CLOSE_UNVERIFIED = /close UNVERIFIED/u;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseResource(raw: unknown): PayerResource {
  if (!isRecord(raw) || typeof raw.externalName !== "string")
    throw new PayerError(
      "network",
      "actuator returned a malformed resource",
      true
    );
  const state = raw.state;
  return {
    externalName: raw.externalName,
    state:
      state === "pending" || state === "active" || state === "closed"
        ? state
        : "unknown",
    endpoints: Array.isArray(raw.endpoints)
      ? raw.endpoints.filter((e): e is string => typeof e === "string")
      : [],
    providerAccount:
      typeof raw.providerAccount === "string" ? raw.providerAccount : undefined,
  };
}

export class ActuatorPayer implements PayerPort {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly cfg: ActuatorPayerConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async post(
    path: string,
    body: unknown,
    timeoutMs: number,
    mutating: boolean
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.cfg.actuatorUrl.replace(/\/+$/, "")}${path}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.cfg.token}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        }
      );
    } catch (error) {
      throw new PayerError(
        "network",
        `actuator ${path} unreachable: ${error instanceof Error ? error.message : "unknown"}`,
        mutating
      );
    }
    const text = await res.text().catch(() => "");
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.ok) return json;
    const code =
      isRecord(json) && typeof json.code === "string" ? json.code : undefined;
    const message =
      isRecord(json) && typeof json.message === "string"
        ? json.message
        : text.slice(0, 200);
    const mapped: PayerErrorCode =
      code && KNOWN_CODES.has(code)
        ? (code as PayerErrorCode)
        : res.status >= 500
          ? "provider_unavailable"
          : "invalid_request";
    throw new PayerError(
      mapped,
      `actuator ${path} -> HTTP ${res.status} ${mapped}: ${message}`.slice(
        0,
        400
      ),
      mutating && AMBIGUOUS.has(mapped),
      mutating &&
        mapped === "provider_rejected" &&
        !CLOSE_UNVERIFIED.test(message)
    );
  }

  async create(req: PayerCreateRequest): Promise<PayerResource> {
    const exclude = (req.excludeProviders ?? []).filter((p) =>
      PROVIDER_ACCOUNT.test(p)
    );
    // Same strictness as `exclude`: only well-formed accounts, deduped, at most the wire's 16. A
    // malformed or over-long caller list is NARROWED here, never widened: an empty result is simply
    // not sent (and the sequencer never calls with an empty list).
    const allow = [
      ...new Set(
        (req.allowProviders ?? []).filter((p) => PROVIDER_ACCOUNT.test(p))
      ),
    ].slice(0, 16);
    if ((req.allowProviders?.length ?? 0) > 0 && allow.length === 0)
      // Never turn an allowlist that was REQUESTED into "no allowlist": refuse before anything is paid.
      throw new PayerError(
        "invalid_request",
        "allowProviders held no well-formed provider account; refusing rather than widening placement",
        false
      );
    const out = await this.post(
      "/v1/akash/create",
      {
        cogniKey: req.cogniKey,
        environment: req.environment,
        identity: req.identity,
        spec: req.spec,
        // Only when non-empty: absent stays byte-identical to the pre-exclusion wire. Only well-formed
        // account addresses are sent (the wire is strict: one malformed value would 400 the create).
        ...(exclude.length > 0 ? { excludeProviders: exclude } : {}),
        // Absent stays byte-identical to the pre-task.5405 wire.
        ...(allow.length > 0 ? { allowProviders: allow } : {}),
      },
      this.cfg.createTimeoutMs ?? 600_000,
      true
    );
    return parseResource(out);
  }

  async observe(req: {
    cogniKey: string;
    externalName?: string;
  }): Promise<{ found: boolean; resource?: PayerResource }> {
    const out = await this.post(
      "/v1/akash/observe",
      {
        cogniKey: req.cogniKey,
        ...(req.externalName ? { externalName: req.externalName } : {}),
      },
      this.cfg.readTimeoutMs ?? 60_000,
      false
    );
    if (!isRecord(out) || typeof out.found !== "boolean")
      throw new PayerError(
        "network",
        "actuator observe returned a malformed body",
        false
      );
    return out.found && out.resource !== undefined
      ? { found: true, resource: parseResource(out.resource) }
      : { found: out.found };
  }

  async delete(req: { cogniKey: string; externalName: string }): Promise<void> {
    await this.post(
      "/v1/akash/delete",
      { cogniKey: req.cogniKey, externalName: req.externalName },
      this.cfg.readTimeoutMs ?? 120_000,
      false
    );
  }
}
