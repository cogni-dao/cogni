// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import type {
  ConfirmResult,
  CredentialLookup,
  CredentialPolicy,
  CredentialState,
  CredentialStore,
  IssueResult,
} from "@cogni-dao/agent-grants/credentials";

interface Row {
  id: string;
  userId: string;
  tokenHash: string;
  createdFrom: string;
  predecessorId: string | null;
  expiresAt: number;
  renewUntil: number;
  pendingExpiresAt: number;
  confirmedAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
}

export interface MemoryUser {
  wallet?: boolean;
  internal?: boolean;
  roles?: boolean;
  github?: boolean;
}

/**
 * In-memory store with the same semantics as the Postgres adapter's SQL: state derived from timestamps against ONE clock (the "database"
 * clock, `clock.now`), one pending successor per predecessor, confirm retires the predecessor. The component test runs the real SQL.
 */
export function memoryCredentialStore(init: {
  users: Record<string, MemoryUser>;
  failing?: boolean;
}) {
  const clock = { now: Date.parse("2026-11-10T12:00:00Z") };
  const rows: Row[] = [];
  const outage = {
    failing: init.failing ?? false,
    /** Fail only this store method (an outage AFTER a successful verify). */ failOn:
      null as string | null,
  };
  let seq = 0;
  const guard = (method: string) => {
    if (outage.failing || outage.failOn === method) throw new Error("db down");
  };
  const state = (r: Row): CredentialState =>
    r.revokedAt !== null
      ? "revoked"
      : r.confirmedAt === null
        ? r.pendingExpiresAt > clock.now
          ? "pending"
          : "pending_expired"
        : r.expiresAt > clock.now
          ? "active"
          : r.renewUntil > clock.now
            ? "renew_only"
            : "expired";
  const plus = (sec: number) => clock.now + sec * 1000;
  const pending = (
    userId: string,
    tokenHash: string,
    createdFrom: string,
    predecessorId: string | null,
    p: CredentialPolicy
  ): Row => {
    const row: Row = {
      id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
      userId,
      tokenHash,
      createdFrom,
      predecessorId,
      expiresAt: plus(p.ttlSec),
      renewUntil: plus(p.ttlSec + p.renewWindowSec),
      pendingExpiresAt: plus(p.pendingSec),
      confirmedAt: null,
      revokedAt: null,
      revokedReason: null,
    };
    rows.push(row);
    return row;
  };
  const revokeRow = (r: Row, reason: string) => {
    r.revokedAt = clock.now;
    r.revokedReason = reason;
  };
  const iso = (ms: number) => new Date(ms).toISOString();

  const store: CredentialStore = {
    async lookup(tokenHash): Promise<CredentialLookup | null> {
      guard("lookup");
      const r = rows.find((x) => x.tokenHash === tokenHash);
      return r
        ? {
            credentialId: r.id,
            userId: r.userId,
            name: `name-${r.userId}`,
            state: state(r),
            expiresAt: iso(r.expiresAt),
            renewUntil: iso(r.renewUntil),
          }
        : null;
    },
    async issueUpgrade({ userId, tokenHash, policy }): Promise<IssueResult> {
      guard("issueUpgrade");
      const u = init.users[userId];
      if (!u) return { ok: false, reason: "unknown_user" };
      if (u.wallet) return { ok: false, reason: "wallet_user" };
      if (u.internal) return { ok: false, reason: "internal_principal" };
      if (
        rows.some(
          (r) =>
            r.userId === userId && ["active", "renew_only"].includes(state(r))
        )
      )
        return { ok: false, reason: "already_upgraded" };
      if (u.roles && !u.github)
        return { ok: false, reason: "binding_required" };
      for (const r of rows)
        if (
          r.userId === userId &&
          r.createdFrom === "legacy_upgrade" &&
          r.confirmedAt === null &&
          r.revokedAt === null
        )
          revokeRow(r, "superseded");
      const row = pending(userId, tokenHash, "legacy_upgrade", null, policy);
      return {
        ok: true,
        credentialId: row.id,
        userId,
        pendingExpiresAt: iso(row.pendingExpiresAt),
      };
    },
    async issueSuccessor({
      predecessorId,
      tokenHash,
      policy,
    }): Promise<IssueResult> {
      guard("issueSuccessor");
      const pred = rows.find((r) => r.id === predecessorId);
      if (!pred || !["active", "renew_only"].includes(state(pred)))
        return { ok: false, reason: "not_rotatable" };
      for (const r of rows)
        if (
          r.predecessorId === predecessorId &&
          r.confirmedAt === null &&
          r.revokedAt === null
        )
          revokeRow(r, "superseded");
      const row = pending(
        pred.userId,
        tokenHash,
        "rotation",
        predecessorId,
        policy
      );
      return {
        ok: true,
        credentialId: row.id,
        userId: pred.userId,
        pendingExpiresAt: iso(row.pendingExpiresAt),
      };
    },
    async confirm({ credentialId, policy }): Promise<ConfirmResult> {
      guard("confirm");
      const r = rows.find((x) => x.id === credentialId);
      if (!r) return { ok: false, reason: "not_found" };
      const s = state(r);
      const done = (status: "confirmed" | "already_active") => ({
        ok: true as const,
        status,
        userId: r.userId,
        expiresAt: iso(r.expiresAt),
        renewUntil: iso(r.renewUntil),
      });
      if (s === "revoked") return { ok: false, reason: "revoked" };
      if (s === "pending_expired" || s === "expired")
        return { ok: false, reason: "expired" };
      if (s === "active" || s === "renew_only") return done("already_active");
      const pred = r.predecessorId
        ? rows.find((x) => x.id === r.predecessorId)
        : undefined;
      if (pred?.revokedAt !== null && pred)
        return { ok: false, reason: "predecessor_revoked" };
      r.confirmedAt = clock.now;
      r.expiresAt = plus(policy.ttlSec);
      r.renewUntil = plus(policy.ttlSec + policy.renewWindowSec);
      if (pred) revokeRow(pred, "rotated");
      return done("confirmed");
    },
    async everConfirmed(userId) {
      guard("everConfirmed");
      return rows.some((r) => r.userId === userId && r.confirmedAt !== null);
    },
    async revoke({ credentialId, userId, reason }) {
      guard("revoke");
      const r = rows.find(
        (x) =>
          x.id === credentialId && x.userId === userId && x.revokedAt === null
      );
      if (!r) return false;
      revokeRow(r, reason);
      for (const s of rows)
        if (
          s.predecessorId === credentialId &&
          s.confirmedAt === null &&
          s.revokedAt === null
        )
          revokeRow(s, "predecessor_revoked");
      return true;
    },
  };
  return {
    store,
    rows,
    clock,
    outage,
    advance: (sec: number) => {
      clock.now += sec * 1000;
    },
  };
}
