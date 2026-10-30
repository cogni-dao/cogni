// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `hmac`
 * Purpose: Purpose-only capability. Any holder of the verifier keyring can also mint. No IO.
 * Scope: Additive operator-only measured-admission core. No runtime activation.
 * Invariants: Existing receipt identity; no new pool, ledger or provider authority.
 * Side-effects: None at import; explicit callers own lifecycle.
 * Links: task.5385, compute-egress-measurement-writer
 * @internal
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { EgressReportIdentity } from "@/types/egress-admission";

export type EgressReportKeyring = Readonly<Record<string, Uint8Array>>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function payload(identity: EgressReportIdentity): string {
  if (
    !UUID.test(identity.receiptId) ||
    !UUID.test(identity.nodeId) ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(identity.lane) ||
    !/^[a-zA-Z0-9._-]{1,64}$/.test(identity.keyVersion) ||
    identity.compositeUid.length < 1 ||
    identity.compositeUid.length > 128
  ) {
    throw new Error("egress_invalid_identity");
  }
  return JSON.stringify([
    "cogni:compute-egress-report:v1",
    identity.keyVersion,
    identity.receiptId,
    identity.nodeId,
    identity.lane,
    identity.compositeUid,
  ]);
}
export function mintReportCapability(
  identity: EgressReportIdentity,
  keyring: EgressReportKeyring
): string {
  const input = payload(identity);
  const key = Object.hasOwn(keyring, identity.keyVersion)
    ? keyring[identity.keyVersion]
    : undefined;
  if (!key || key.byteLength !== 32)
    throw new Error("egress_missing_key_version");
  return createHmac("sha256", key).update(input).digest("base64url");
}
/** Strict canonical token and identity checks precede crypto, and ALL database work. */
export function verifyReportCapability(
  identity: EgressReportIdentity,
  token: string,
  keyring: EgressReportKeyring
): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  try {
    const expected = mintReportCapability(identity, keyring);
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}
