// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createDoltGrpcRemoteAdapter } from "../src/adapters/dolt-grpc-remote.js";
import { DoltRemotePortError } from "../src/ports/dolt-remote.port.js";

function fakeSql(opts: { addError?: Error; pushError?: Error } = {}): {
  sql: Sql;
  statements: string[];
} {
  const statements: string[] = [];
  const unsafe = (s: string) => {
    statements.push(s);
    if (/dolt_remote/.test(s) && opts.addError)
      return Promise.reject(opts.addError);
    if (/dolt_push/.test(s) && opts.pushError)
      return Promise.reject(opts.pushError);
    return Promise.resolve([]);
  };
  const sql = { unsafe, end: () => Promise.resolve() } as unknown as Sql;
  return { sql, statements };
}

const cfg = {
  node: "operator",
  remoteName: "origin",
  remoteUrl: "https://doltremoteapi.dolthub.com/cogni-dao/knowledge-operator",
  branch: "main",
};

describe("DoltGrpcRemoteAdapter", () => {
  it("emits dolt_remote add then dolt_push (additive only)", async () => {
    const { sql, statements } = fakeSql();
    const adapter = createDoltGrpcRemoteAdapter({ sql, ...cfg });
    const result = await adapter.push();
    expect(statements[0]).toContain("dolt_remote('add', 'origin'");
    expect(statements[0]).toContain(cfg.remoteUrl);
    expect(statements[1]).toBe("SELECT dolt_push('origin', 'main')");
    expect(result).toEqual({
      node: "operator",
      remote: cfg.remoteUrl,
      branch: "main",
    });
    expect(adapter.kind).toBe("grpc");
  });

  it("swallows 'remote already exists' on add, still pushes", async () => {
    const { sql, statements } = fakeSql({
      addError: new Error("error: remote already exists"),
    });
    const adapter = createDoltGrpcRemoteAdapter({ sql, ...cfg });
    await adapter.push();
    expect(statements.some((s) => /dolt_push/.test(s))).toBe(true);
  });

  it("translates push failure to DoltRemotePortError", async () => {
    const { sql } = fakeSql({ pushError: new Error("permission denied") });
    const adapter = createDoltGrpcRemoteAdapter({ sql, ...cfg });
    await expect(adapter.push()).rejects.toBeInstanceOf(DoltRemotePortError);
  });

  it("rethrows non-'already exists' add failures", async () => {
    const { sql } = fakeSql({ addError: new Error("connection refused") });
    const adapter = createDoltGrpcRemoteAdapter({ sql, ...cfg });
    await expect(adapter.push()).rejects.toBeInstanceOf(DoltRemotePortError);
  });
});
