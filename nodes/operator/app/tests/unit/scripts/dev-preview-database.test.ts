// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { describe, expect, it, vi } from "vitest";
import {
  type DevPreviewDatabaseResetDeps,
  devPreviewDatabasePair,
  devPreviewDatabaseUrls,
  resetDevPreviewDatabasePair,
} from "../../../scripts/dev-preview-database";

const source = {
  app: "postgresql://app_spawny_boi:test@84.32.149.0:5432/cogni_spawny_boi?sslmode=disable",
  service:
    "postgresql://service_spawny_boi:test@84.32.149.0:5432/cogni_spawny_boi?sslmode=disable",
  migration:
    "postgresql://migration_spawny_boi:test@84.32.149.0:5432/cogni_spawny_boi?sslmode=disable",
  doltgres:
    "postgresql://postgres:test@84.32.149.0:5435/knowledge_spawny_boi?sslmode=disable",
};

describe("disposable TEST database binding", () => {
  it("requires previous lease history for an existing pair without destructive SQL", async () => {
    const sql = vi.fn<DevPreviewDatabaseResetDeps["sql"]>(
      async () => "cogni_spawny_boi_preview_a"
    );
    const deps: DevPreviewDatabaseResetDeps = {
      withReservedUnallocatedPair: async (_slot, _id, _previous, action) =>
        action(),
      observePreviousLease: async () => "closed",
      assertNoMigrationWriters: async () => {},
      save: async () => {},
      sql,
    };
    await expect(
      resetDevPreviewDatabasePair(
        { stateSlot: 0, deploymentId: "preview-a" },
        deps
      )
    ).rejects.toThrow("PREVIOUS_PREVIEW_HISTORY_REQUIRED");
    expect(sql.mock.calls.every((call) => call[2]?.startsWith("SELECT"))).toBe(
      true
    );
  });

  it("only targets the selected allowlisted pair and persists generation before reset", async () => {
    const events: string[] = [];
    const deps: DevPreviewDatabaseResetDeps = {
      withReservedUnallocatedPair: async (_slot, _id, _previous, action) =>
        action(),
      observePreviousLease: async () => "closed",
      assertNoMigrationWriters: async () => {},
      save: async (record) => {
        events.push(record.phase);
        expect(record.resetGeneration).toMatch(/^[0-9a-f-]{36}$/);
      },
      sql: async (_engine, database, statement) => {
        expect(["postgres", "cogni_spawny_boi_preview_b"]).toContain(database);
        expect(statement).not.toMatch(/preview_a|CREATE ROLE|PASSWORD|FORCE/);
        events.push("sql");
        return "";
      },
    };
    const result = await resetDevPreviewDatabasePair(
      {
        stateSlot: 1,
        deploymentId: "preview-b",
        previousExternalName: "akash-124",
      },
      deps
    );
    expect(events[0]).toBe("resetting");
    expect(events.at(-1)).toBe("empty");
    expect(result.phase).toBe("empty");
  });

  it("partial SQL failure keeps durable resetting and never emits empty completion", async () => {
    const phases: string[] = [];
    const deps: DevPreviewDatabaseResetDeps = {
      withReservedUnallocatedPair: async (_slot, _id, _previous, action) =>
        action(),
      observePreviousLease: async () => "closed",
      assertNoMigrationWriters: async () => {},
      save: async (record) => {
        phases.push(record.phase);
      },
      sql: async () => {
        throw new Error("TEST_SQL_FAILURE");
      },
    };
    await expect(
      resetDevPreviewDatabasePair(
        {
          stateSlot: 0,
          deploymentId: "preview-a",
          previousExternalName: "akash-123",
        },
        deps
      )
    ).rejects.toThrow("TEST_SQL_FAILURE");
    expect(phases).toEqual(["resetting"]);
  });
  it("refuses resetting the current admission once allocation has begun", async () => {
    const sql = vi.fn();
    const deps: DevPreviewDatabaseResetDeps = {
      withReservedUnallocatedPair: async () => {
        throw new Error("CURRENT_APP_NOT_QUIESCENT");
      },
      observePreviousLease: async () => "closed",
      assertNoMigrationWriters: async () => {},
      save: async () => {},
      sql,
    };
    await expect(
      resetDevPreviewDatabasePair(
        { stateSlot: 0, deploymentId: "preview-a" },
        deps
      )
    ).rejects.toThrow("CURRENT_APP_NOT_QUIESCENT");
    expect(sql).not.toHaveBeenCalled();
  });
  it("maps exactly two slots and reuses selected node credentials", () => {
    expect(devPreviewDatabasePair(0).postgresDatabase).toBe(
      "cogni_spawny_boi_preview_a"
    );
    expect(devPreviewDatabasePair(1).doltgresDatabase).toBe(
      "knowledge_spawny_boi_preview_b"
    );
    const result = devPreviewDatabaseUrls(1, source);
    expect(new URL(result.app).password).toBe(new URL(source.app).password);
    expect(new URL(result.service).pathname).toBe(
      "/cogni_spawny_boi_preview_b"
    );
    expect(new URL(result.doltgres).pathname).toBe(
      "/knowledge_spawny_boi_preview_b"
    );
    expect(() => devPreviewDatabasePair(2 as 0)).toThrow(
      "INVALID_PREVIEW_DATABASE_SLOT"
    );
  });

  it.each([
    source.app.replace("84.32.149.0", "production.example.org"),
    source.app.replace("cogni_spawny_boi?", "cogni_operator?"),
    source.app.replace("app_spawny_boi", "postgres"),
  ])("rejects a foreign binding before any database IO", (app) => {
    expect(() => devPreviewDatabaseUrls(0, { ...source, app })).toThrow(
      "TEST_DATABASE_BINDING_MISMATCH"
    );
  });

  it("never resets an unknown previous lease", async () => {
    const sql = vi.fn();
    const deps: DevPreviewDatabaseResetDeps = {
      withReservedUnallocatedPair: async (_slot, _id, _previous, action) =>
        action(),
      observePreviousLease: async () => "unknown",
      assertNoMigrationWriters: async () => {},
      save: async () => {},
      sql,
    };
    await expect(
      resetDevPreviewDatabasePair(
        {
          stateSlot: 0,
          deploymentId: "preview-a",
          previousExternalName: "akash-123",
        },
        deps
      )
    ).rejects.toThrow("PREVIOUS_PREVIEW_CLOSURE_UNPROVEN");
    expect(sql).not.toHaveBeenCalled();
  });

  it("never resets while a migration Job or Pod could still write", async () => {
    const sql = vi.fn();
    const deps: DevPreviewDatabaseResetDeps = {
      withReservedUnallocatedPair: async (_slot, _id, _previous, action) =>
        action(),
      observePreviousLease: async () => "closed",
      assertNoMigrationWriters: async () => {
        throw new Error("MIGRATION_WRITER_PENDING");
      },
      save: async () => {},
      sql,
    };
    await expect(
      resetDevPreviewDatabasePair(
        {
          stateSlot: 1,
          deploymentId: "preview-b",
          previousExternalName: "akash-124",
        },
        deps
      )
    ).rejects.toThrow("MIGRATION_WRITER_PENDING");
    expect(sql).not.toHaveBeenCalled();
  });
});
