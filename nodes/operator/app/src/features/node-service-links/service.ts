// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-service-links/service`
 * Purpose: The operator's side of node-service enrollment (story.0038): start a link to node X, drive
 *   the poll to a stored key, and cut the operator's copy. The operator `git-review` service earns an
 *   X-issued revocable key by one signed request and one X admin click.
 * Scope: Policy and state machine over injected ports. Does no IO of its own, holds no HTTP, DB or JOSE.
 * Invariants:
 *   - ONE_OPEN_LINK_PER_NODE_SERVICE: a start for a node with a `pending` or `connected` link returns it.
 *   - START_CAP: at most 5 link starts per developer per hour.
 *   - POLL_DRIVER_NO_TEMPORAL: `step` is the only poll driver; the GET handler and the review start call
 *     it. It polls X at most once per `max(5 s, interval)` (the slot is claimed before the call).
 *   - KEY_NEVER_LEAVES_THE_STEP: the sealed JWE is opened, vaulted and confirmed inside `step`; the
 *     answer carries a state and a connection id only. No log field carries a key, device code or JWE.
 *   - UNCONFIRMED_KEY_IS_NOT_KEPT: when X's confirm fails the just-stored row is revoked and the link
 *     stays `pending`; the next poll replays the device code and X supersedes the pending key.
 *   - KEY_REJECTED_NEEDS_REENROLL: a 401 from X on a stored key revokes the row and marks the link
 *     `needs_reenroll`; no other path moves a `connected` link.
 * Side-effects: IO through ports only.
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment, story.0038,
 *   packages/node-contracts/src/node.service-link.v1.contract.ts
 * @public
 */

import {
  type NodeServiceName,
  SERVICE_ENROLLMENT_SCOPES,
  SERVICE_ENROLLMENT_TTL_SECONDS,
  SERVICE_ENROLLMENT_V1,
  ServiceEnrollmentClaimsSchema,
  serviceEnrollmentAudience,
} from "@cogni/node-contracts";
import {
  EnrollmentTransportError,
  type NodeEnrollmentTransportPort,
  type NodeServiceLinkRecord,
  type NodeServiceLinkStorePort,
  OpenServiceLinkExistsError,
  type ServiceConnectionWriterPort,
  type ServiceEnrollmentSignerPort,
  type ServiceKeyCryptoPort,
} from "@/ports";
import { EVENT_NAMES } from "@/shared/observability";

/** Link starts allowed per developer per hour. */
export const SERVICE_LINK_STARTS_PER_HOUR = 5;
/** Floor of the poll gap, whatever X's interval says. */
export const SERVICE_LINK_MIN_POLL_GAP_S = 5;
/** The X-issued key lives 30 days; the expiring event fires from day 20 (10 days left). */
const KEY_LIFETIME_MS = 30 * 86_400_000;
const KEY_EXPIRING_AFTER_MS = 20 * 86_400_000;
/** `slow_down` adds this many seconds to the interval (RFC 8628). */
const SLOW_DOWN_STEP_S = 5;

export interface ServiceLinkLog {
  info(fields: Record<string, unknown>, msg?: string): void;
  warn(fields: Record<string, unknown>, msg?: string): void;
}

export interface NodeServiceLinkDeps {
  readonly store: NodeServiceLinkStorePort;
  readonly signer: ServiceEnrollmentSignerPort;
  readonly transport: NodeEnrollmentTransportPort;
  readonly crypto: ServiceKeyCryptoPort;
  readonly connections: ServiceConnectionWriterPort;
  /** Operator origin (`iss`): the issuer X trusts for this service. */
  readonly issuer: string;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly log: ServiceLinkLog;
}

export type StartServiceLinkResult =
  | {
      readonly ok: true;
      readonly link: NodeServiceLinkRecord;
      readonly created: boolean;
    }
  | {
      readonly ok: false;
      readonly status: 429 | 502;
      readonly errorCode:
        | "link_start_rate_limited"
        | "enrollment_origin_unreachable"
        | "enrollment_rejected"
        | "enrollment_bad_response";
    };

export interface NodeServiceLinkService {
  start(input: {
    readonly nodeId: string;
    readonly service: NodeServiceName;
    /** Registered origin of X from the node registry, never the request body. */
    readonly audience: string;
    readonly requestedByUserId: string;
  }): Promise<StartServiceLinkResult>;
  /** Run at most one poll step for a `pending` link; returns the link as it stands after. */
  step(link: NodeServiceLinkRecord): Promise<NodeServiceLinkRecord>;
  get(nodeId: string, linkId: string): Promise<NodeServiceLinkRecord | null>;
  /** The open link for a node and service after one poll step (review start uses this). */
  openLink(
    nodeId: string,
    service: NodeServiceName
  ): Promise<NodeServiceLinkRecord | null>;
  /** Drop the operator's copy: revoke the stored key, mark the link `superseded`. */
  remove(link: NodeServiceLinkRecord): Promise<void>;
  /** X answered 401 to a stored key: revoke it and mark the link `needs_reenroll`. */
  markKeyRejected(audience: string, service: NodeServiceName): Promise<void>;
}

const transportFailure = (
  error: unknown
):
  | "enrollment_origin_unreachable"
  | "enrollment_rejected"
  | "enrollment_bad_response" => {
  if (error instanceof EnrollmentTransportError) {
    if (error.code === "origin_unreachable")
      return "enrollment_origin_unreachable";
    if (error.code === "bad_response") return "enrollment_bad_response";
  }
  return "enrollment_rejected";
};

export function createNodeServiceLinkService(
  deps: NodeServiceLinkDeps
): NodeServiceLinkService {
  const { store, log } = deps;

  const failed = (
    link: NodeServiceLinkRecord,
    failureCode: string
  ): Promise<void> => {
    log.warn(
      {
        event: EVENT_NAMES.AGENT_NODE_LINK_FAILED,
        linkId: link.id,
        targetNodeId: link.nodeId,
        service: link.service,
        errorCode: failureCode,
      },
      EVENT_NAMES.AGENT_NODE_LINK_FAILED
    );
    return store.markState(link.id, "failed", failureCode);
  };

  async function step(
    link: NodeServiceLinkRecord
  ): Promise<NodeServiceLinkRecord> {
    if (link.state !== "pending") return link;
    const now = deps.now();
    if (link.deviceCodeExpiresAt.getTime() <= now.getTime()) {
      await failed(link, "expired_token");
      return (await store.findById(link.id)) ?? link;
    }
    const gapS = Math.max(SERVICE_LINK_MIN_POLL_GAP_S, link.pollIntervalS);
    if (!(await store.claimPoll(link.id, now, gapS * 1000))) return link;

    const secrets = await store.readSecrets(link.id);
    if (!secrets) return (await store.findById(link.id)) ?? link;

    let result: Awaited<ReturnType<NodeEnrollmentTransportPort["pollToken"]>>;
    try {
      result = await deps.transport.pollToken(
        link.audience,
        secrets.deviceCode
      );
    } catch {
      // Transient (origin down, bad body): the claimed slot already spaces the retry.
      return (await store.findById(link.id)) ?? link;
    }

    if (result.kind === "slow_down") {
      await store.setPollInterval(
        link.id,
        link.pollIntervalS + SLOW_DOWN_STEP_S
      );
    } else if (result.kind === "access_denied") {
      await failed(link, "access_denied");
    } else if (result.kind === "expired_token") {
      await failed(link, "expired_token");
    } else if (result.kind === "issued") {
      let apiKey: string;
      try {
        apiKey = await deps.crypto.openSealedKey(
          result.sealedKey,
          secrets.cnfPrivateJwk
        );
      } catch {
        await failed(link, "sealed_key_unreadable");
        return (await store.findById(link.id)) ?? link;
      }
      const connectionId = await deps.connections.store({
        audience: link.audience,
        apiKey,
        scopes: SERVICE_ENROLLMENT_SCOPES,
      });
      let confirmed = false;
      try {
        confirmed = (await deps.transport.confirmKey(link.audience, apiKey)).ok;
      } catch {
        confirmed = false;
      }
      if (!confirmed) {
        await deps.connections.revoke(connectionId);
        log.warn(
          {
            event: EVENT_NAMES.AGENT_NODE_LINK_FAILED,
            linkId: link.id,
            targetNodeId: link.nodeId,
            service: link.service,
            errorCode: "confirm_not_accepted",
          },
          EVENT_NAMES.AGENT_NODE_LINK_FAILED
        );
      } else {
        await store.markConnected(link.id, connectionId);
        log.info(
          {
            event: EVENT_NAMES.AGENT_NODE_LINK_CONNECTED,
            linkId: link.id,
            targetNodeId: link.nodeId,
            service: link.service,
            connectionId,
          },
          EVENT_NAMES.AGENT_NODE_LINK_CONNECTED
        );
      }
    }
    return (await store.findById(link.id)) ?? link;
  }

  return {
    async start(input) {
      const now = deps.now();
      const existing = await store.findOpen(input.nodeId, input.service);
      if (existing) {
        const stale =
          existing.state === "pending" &&
          existing.deviceCodeExpiresAt.getTime() <= now.getTime();
        if (!stale) return { ok: true, link: existing, created: false };
        await failed(existing, "expired_token");
      }
      const since = new Date(now.getTime() - 3_600_000);
      if (
        (await store.countStartsSince(input.requestedByUserId, since)) >=
        SERVICE_LINK_STARTS_PER_HOUR
      ) {
        return {
          ok: false,
          status: 429,
          errorCode: "link_start_rate_limited",
        };
      }

      const keypair = await deps.crypto.generateLinkKeypair();
      const jti = deps.newId();
      const iat = Math.floor(now.getTime() / 1000);
      const claims = ServiceEnrollmentClaimsSchema.parse({
        iss: deps.issuer,
        aud: serviceEnrollmentAudience(input.nodeId),
        kind: SERVICE_ENROLLMENT_V1,
        jti,
        iat,
        exp: iat + SERVICE_ENROLLMENT_TTL_SECONDS,
        service: input.service,
        scopes: [...SERVICE_ENROLLMENT_SCOPES],
        cnf: { jwk: keypair.publicJwk },
      });
      const token = await deps.signer.sign(claims);

      let accepted: Awaited<
        ReturnType<NodeEnrollmentTransportPort["postEnrollment"]>
      >;
      try {
        accepted = await deps.transport.postEnrollment(input.audience, token);
      } catch (error) {
        const errorCode = transportFailure(error);
        log.warn(
          {
            event: EVENT_NAMES.AGENT_NODE_LINK_FAILED,
            targetNodeId: input.nodeId,
            service: input.service,
            errorCode,
            ...(error instanceof EnrollmentTransportError && error.status
              ? { status: error.status }
              : {}),
          },
          EVENT_NAMES.AGENT_NODE_LINK_FAILED
        );
        return {
          ok: false,
          status: 502,
          errorCode,
        };
      }

      let link: NodeServiceLinkRecord;
      try {
        link = await store.insert({
          nodeId: input.nodeId,
          service: input.service,
          audience: input.audience,
          requestedByUserId: input.requestedByUserId,
          jti,
          deviceCode: accepted.deviceCode,
          cnfPrivateJwk: keypair.privateJwk,
          pollIntervalS: Math.max(
            SERVICE_LINK_MIN_POLL_GAP_S,
            accepted.intervalS
          ),
          deviceCodeExpiresAt: new Date(
            now.getTime() + accepted.expiresInS * 1000
          ),
        });
      } catch (error) {
        if (error instanceof OpenServiceLinkExistsError) {
          const winner = await store.findOpen(input.nodeId, input.service);
          if (winner) return { ok: true, link: winner, created: false };
        }
        throw error;
      }
      log.info(
        {
          event: EVENT_NAMES.AGENT_NODE_LINK_REQUESTED,
          linkId: link.id,
          targetNodeId: link.nodeId,
          service: link.service,
        },
        EVENT_NAMES.AGENT_NODE_LINK_REQUESTED
      );
      return { ok: true, link, created: true };
    },

    step,

    async get(nodeId, linkId) {
      const link = await store.findById(linkId);
      if (!link || link.nodeId !== nodeId) return null;
      return step(link);
    },

    async openLink(nodeId, service) {
      const link = await store.findOpen(nodeId, service);
      if (!link) return null;
      const after = await step(link);
      if (
        after.state === "connected" &&
        after.connectedAt &&
        deps.now().getTime() - after.connectedAt.getTime() >
          KEY_EXPIRING_AFTER_MS
      ) {
        log.warn(
          {
            event: EVENT_NAMES.AGENT_NODE_KEY_EXPIRING,
            linkId: after.id,
            targetNodeId: after.nodeId,
            service: after.service,
            daysLeft: Math.max(
              0,
              Math.ceil(
                (KEY_LIFETIME_MS -
                  (deps.now().getTime() - after.connectedAt.getTime())) /
                  86_400_000
              )
            ),
          },
          EVENT_NAMES.AGENT_NODE_KEY_EXPIRING
        );
      }
      return after;
    },

    async remove(link) {
      if (link.connectionId) await deps.connections.revoke(link.connectionId);
      await store.markState(link.id, "superseded", "removed");
    },

    async markKeyRejected(audience, service) {
      const link = await store.findConnectedByAudience(audience, service);
      if (!link) return;
      if (link.connectionId) await deps.connections.revoke(link.connectionId);
      await store.markState(link.id, "needs_reenroll", "key_rejected");
      log.warn(
        {
          event: EVENT_NAMES.AGENT_NODE_LINK_KEY_REJECTED,
          linkId: link.id,
          targetNodeId: link.nodeId,
          service,
        },
        EVENT_NAMES.AGENT_NODE_LINK_KEY_REJECTED
      );
    },
  };
}
