// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_lib/auth/agent-v1-hard-stop`
 * Purpose: Effective hard stop for v1 agent-key renewal (task.5475 C1).
 * Invariants: HARD_STOP_ONLY_SHORTENS — effective = min(code default, env);
 *   an env value later than the default is ignored (reported as `clamped`);
 *   an unparsable env value yields null (caller fails closed).
 * Side-effects: none
 * @internal
 */

export const AGENT_V1_HARD_STOP_DEFAULT = new Date("2027-01-31T00:00:00Z");

export function effectiveAgentV1HardStop(
  envValue: string | undefined
): { hardStop: Date; clamped: boolean } | null {
  if (envValue === undefined || envValue === "") {
    return { hardStop: AGENT_V1_HARD_STOP_DEFAULT, clamped: false };
  }
  const parsed = new Date(envValue);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getTime() > AGENT_V1_HARD_STOP_DEFAULT.getTime()) {
    return { hardStop: AGENT_V1_HARD_STOP_DEFAULT, clamped: true };
  }
  return { hardStop: parsed, clamped: false };
}
