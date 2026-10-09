// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/observability-db-schema.test`
 * Purpose: Pin the migration-receipt contract and the never-reported-vs-zero distinction.
 * Scope: Pure unit coverage of the parser, drift diff and readout shaper; does not touch a database or
 *   start a server. Also pins the TWINS against `scripts/db/migrate.mjs`.
 * Invariants:
 *   - THE_TWIN_IS_PINNED: the marker + field names this parser expects are asserted to be present
 *     in the standalone migrator script, which cannot import them.
 *   - SILENCE_IS_NOT_SUCCESS is asserted as a behaviour, not a comment.
 * Side-effects: IO (reads two source files to pin the twins)
 * Links: shared/migrations/migration-receipt.ts, scripts/db/migrate.mjs
 * @internal
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  diffDeclaredVsApplied,
  hasMissingMigrations as driftHasMissingMigrations,
  MIGRATION_RECEIPT_MARKER,
  parseMigrationReceipt,
} from "@/shared/migrations/migration-receipt";

import {
  hasMissingMigrations,
  NEVER_REPORTED_MESSAGE,
  shapeSchemaReadout,
} from "./observability-db-schema";

const MIGRATOR_PATH = path.join(
  __dirname,
  "../../../../../../scripts/db/migrate.mjs"
);

const receiptLine = (body: unknown): string =>
  `${MIGRATION_RECEIPT_MARKER} ${JSON.stringify(body)}`;

describe("migration receipt — TWINS with the standalone migrator", () => {
  it("restates the marker and every field name the parser reads", () => {
    const source = readFileSync(MIGRATOR_PATH, "utf8");
    expect(source).toContain(MIGRATION_RECEIPT_MARKER);
    for (const field of ["declared", "applied", "appliedAtMs", "hash", "tag"]) {
      expect(source).toContain(field);
    }
    // The migrator must read drizzle's OWN ledger — never any other node's schema.
    expect(source).toContain("drizzle.__drizzle_migrations");
  });
});

describe("parseMigrationReceipt", () => {
  const valid = {
    node: "poly",
    declared: ["0001_a", "0002_b"],
    applied: [{ tag: "0001_a", hash: "h1", appliedAtMs: 10 }],
  };

  it("extracts a receipt embedded in surrounding migrator output", () => {
    const stdout = [
      "NOTICE: schema already exists",
      "✅ poly migrations applied in 42ms",
      receiptLine(valid),
    ].join("\n");
    expect(parseMigrationReceipt(stdout)).toEqual(valid);
  });

  it("takes the LAST receipt when a pod printed several", () => {
    const stdout = [
      receiptLine(valid),
      receiptLine({ ...valid, declared: ["0001_a"] }),
    ].join("\n");
    expect(parseMigrationReceipt(stdout)?.declared).toEqual(["0001_a"]);
  });

  it("treats a malformed or truncated receipt as ABSENT, never as empty", () => {
    expect(parseMigrationReceipt("")).toBeNull();
    expect(
      parseMigrationReceipt(`${MIGRATION_RECEIPT_MARKER} {"decl`)
    ).toBeNull();
    expect(parseMigrationReceipt(receiptLine({ declared: ["x"] }))).toBeNull();
    expect(
      parseMigrationReceipt(
        receiptLine({ declared: ["x"], applied: [{ tag: "x" }] })
      )
    ).toBeNull();
  });
});

describe("diffDeclaredVsApplied", () => {
  it("names the declared migration that did not arrive", () => {
    expect(
      diffDeclaredVsApplied({
        declared: ["0001_a", "0002_b"],
        applied: [{ tag: "0001_a" }],
      })
    ).toEqual({ missing: ["0002_b"], unexpected: [] });
  });

  it("names an applied migration the image no longer declares", () => {
    expect(
      diffDeclaredVsApplied({
        declared: ["0001_a"],
        applied: [{ tag: "0001_a" }, { tag: "0002_b" }],
      })
    ).toEqual({ missing: [], unexpected: ["0002_b"] });
  });
});

describe("hasMissingMigrations — the ONE gate predicate", () => {
  it("absent drift is NOT a failure", () => {
    // The whole safety property. `null` is what every unknown collapses to: no receipt was ever
    // collected, the Job log could not be read, the line was malformed, the node id was not bound
    // yet. A node in any of those states must deploy normally.
    expect(driftHasMissingMigrations(null)).toBe(false);
    expect(driftHasMissingMigrations(undefined)).toBe(false);
  });

  it("clean drift is not a failure, and `unexpected` ALONE is not either", () => {
    expect(driftHasMissingMigrations({ missing: [], unexpected: [] })).toBe(
      false
    );
    // An applied row the journal does not recognise means the IMAGE rolled back past its schema.
    // Loud, but it is not "a declared migration did not arrive" — it must never block a deploy.
    expect(
      driftHasMissingMigrations({
        missing: [],
        unexpected: ["unknown:1791098285556"],
      })
    ).toBe(false);
  });

  it("a declared migration that did not arrive IS a failure", () => {
    expect(
      driftHasMissingMigrations({
        missing: ["0071_gigantic_sister_grimm"],
        unexpected: [],
      })
    ).toBe(true);
  });
});

describe("shapeSchemaReadout — SILENCE_IS_NOT_SUCCESS", () => {
  const cell = { nodeId: "n-1", slug: "poly", env: "production" as const };

  it("never-reported carries nulls and an explanation, not zeroes", () => {
    const readout = shapeSchemaReadout({ ...cell, record: null });
    expect(readout.state).toBe("never_reported");
    expect(readout.message).toBe(NEVER_REPORTED_MESSAGE);
    expect(readout.appliedCount).toBeNull();
    expect(readout.applied).toBeNull();
    expect(readout.declared).toBeNull();
    expect(readout.drift).toBeNull();
    // An unknown must never be laundered into a verdict.
    expect(hasMissingMigrations(readout)).toBe(false);
  });

  it("reported-with-zero-migrations is a DIFFERENT, representable state", () => {
    const readout = shapeSchemaReadout({
      ...cell,
      record: {
        nodeId: "n-1",
        environment: "production",
        declared: [],
        applied: [],
        bundleDigest: null,
        reporter: "migration-job",
        reportedAt: "2026-10-08T00:00:00.000Z",
      },
    });
    expect(readout.state).toBe("reported");
    expect(readout.message).toBeUndefined();
    expect(readout.appliedCount).toBe(0);
    expect(readout.applied).toEqual([]);
    expect(readout.drift).toEqual({ missing: [], unexpected: [] });
  });

  it("flags a reported cell whose declared migration never landed", () => {
    const readout = shapeSchemaReadout({
      ...cell,
      record: {
        nodeId: "n-1",
        environment: "production",
        declared: ["0001_a", "0002_b"],
        applied: [{ tag: "0001_a", hash: "h1", appliedAtMs: 10 }],
        bundleDigest: "sha256:abc",
        reporter: "migration-job",
        reportedAt: "2026-10-08T00:00:00.000Z",
      },
    });
    expect(readout.appliedCount).toBe(1);
    expect(readout.drift?.missing).toEqual(["0002_b"]);
    expect(hasMissingMigrations(readout)).toBe(true);
  });
});
