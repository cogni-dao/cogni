// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/finance/cherry-finance.reader`
 * Purpose: Cherry compute credit — team credit, vendor hourly price and vendor-computed remaining time → burn and runway.
 * Scope: TypeScript port of `cherryPlane()` in scripts/money-plane-snapshot.mjs (PR #2874): GET /v1/teams with the
 *   bearer token through the injected safe fetch, same field paths (`credit.account.remaining`, `credit.account.currency`,
 *   `credit.resources.pricing.price` €/h, `credit.resources.remaining.time` h) and the shared runway grading.
 * Invariants: READERS_NEVER_THROW. No token ⇒ UNKNOWN "no Cherry credential in this runtime". EUR stays EUR, never FX.
 *   Reuses the bearer + Accept header pattern of `cherry-compute.adapter.ts`; the snapshot runner owns the timeout.
 * Side-effects: IO (HTTPS GET via injected fetch)
 * Links: scripts/money-plane-snapshot.mjs, ../compute/cherry-compute.adapter.ts, https://cognidao.org/knowledge/money-plane-registry
 * @public
 */
import {
  type FetchLike,
  gradeRunway,
  type MoneyPlaneRow,
  type PayAction,
  type PlaneReader,
  unknownRow,
} from "@cogni/money-plane";

export const CHERRY_TEAMS_URL = "https://api.cherryservers.com/v1/teams";
export const CHERRY_PLANE = "cherry:team";

export interface CherryFinanceReaderOptions {
  token: string | null | undefined;
  fetch: FetchLike;
  now?: () => Date;
  payAction?: PayAction;
}

interface CherryTeam {
  id?: unknown;
  credit?: {
    account?: { remaining?: unknown; currency?: unknown };
    resources?: {
      pricing?: { price?: unknown };
      remaining?: { time?: unknown };
    };
  };
}

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function cherryFinanceReader(
  options: CherryFinanceReaderOptions
): PlaneReader {
  const plane = CHERRY_PLANE;
  const label = "Cherry credit";
  const now = options.now ?? (() => new Date());
  const withAction =
    options.payAction === undefined ? {} : { payAction: options.payAction };
  const unknown = (
    reasonCode: "unconfigured" | "unreadable",
    detail: string
  ): MoneyPlaneRow => ({
    ...unknownRow({
      plane,
      label,
      kind: "prepaid",
      reasonCode,
      observedAt: now().toISOString(),
      detail,
    }),
    ...withAction,
  });
  return {
    plane,
    label,
    kind: "prepaid",
    ...withAction,
    async read(signal): Promise<MoneyPlaneRow> {
      if (!options.token)
        return unknown("unconfigured", "no Cherry credential in this runtime");
      try {
        const res = await options.fetch(CHERRY_TEAMS_URL, {
          headers: {
            Authorization: `Bearer ${options.token}`,
            Accept: "application/json",
          },
          signal,
        });
        if (!res.ok) return unknown("unreadable", `HTTP ${res.status}`);
        const teams = (await res.json()) as unknown;
        const credit = Array.isArray(teams)
          ? (teams[0] as CherryTeam | undefined)?.credit
          : undefined;
        const balance = finite(credit?.account?.remaining);
        const currency = credit?.account?.currency;
        if (balance === null || typeof currency !== "string")
          return unknown("unreadable", "teams response missing credit");
        const perHour = finite(credit?.resources?.pricing?.price);
        const hours = finite(credit?.resources?.remaining?.time);
        const burnPerDay = perHour === null ? null : perHour * 24;
        const runwayDays = hours === null ? null : hours / 24;
        const observedAt = now().toISOString();
        const base: MoneyPlaneRow = {
          plane,
          label,
          kind: "prepaid",
          balance,
          currency,
          burnPerDay,
          runwayDays,
          grade: "UNKNOWN",
          observedAt,
          source:
            "Cherry team API · price per hour × 24 · vendor remaining time",
          sourceObservedAt: observedAt,
          freshness: "current",
          ...withAction,
        };
        if (balance <= 0)
          return {
            ...base,
            runwayDays: 0,
            grade: "RED",
            detail: "credit exhausted",
          };
        if (runwayDays === null || burnPerDay === null)
          return { ...base, reasonCode: "burn_unmeasured" };
        return { ...base, grade: gradeRunway(runwayDays) };
      } catch {
        return unknown("unreadable", "Cherry read failed");
      }
    },
  };
}
