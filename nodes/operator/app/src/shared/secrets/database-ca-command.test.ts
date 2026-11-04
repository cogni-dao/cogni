// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";

import { describe, expect, it } from "vitest";

import {
  databaseConsumerCommand,
  withDatabaseCaTrust,
} from "./database-ca-command";

describe("database CA process startup", () => {
  it("installs owner-only public trust before Node and preserves hostile positional arguments", () => {
    const hostile = [
      "$(printf compromised)",
      'space and "quotes"',
      "line\nnext",
      "; exit 91",
    ];
    const script =
      'const fs=require("node:fs"); const p=process.env.NODE_EXTRA_CA_CERTS; console.log(JSON.stringify({args:process.argv.slice(1),mode:fs.statSync(p).mode&511,cert:fs.readFileSync(p,"utf8")})); fs.unlinkSync(p);';
    const wrapper = withDatabaseCaTrust(
      [process.execPath, "-e", script],
      hostile
    );
    const executable = wrapper.command[0];
    if (!executable) throw new Error("missing wrapper executable");
    const output = execFileSync(
      executable,
      [...wrapper.command.slice(1), ...wrapper.args],
      {
        env: { NODE_ENV: "test", DATABASE_SSL_CA_CERT: rootCertificates[0] },
        encoding: "utf8",
      }
    );
    expect(JSON.parse(output)).toEqual({
      args: hostile,
      mode: 0o600,
      cert: `${rootCertificates[0]}\n`,
    });
  });

  it("uses the verified standalone default only for the explicit node app profile", () => {
    const command = databaseConsumerCommand({
      runtimeProfile: "cogni-node-app-v1",
      secretRefs: [{ key: "DATABASE_URL" }],
    });
    expect(command.args).toEqual(["node", "app/server.js"]);
    expect(() =>
      databaseConsumerCommand({ secretRefs: [{ key: "DATABASE_URL" }] })
    ).toThrow("declared command");
  });

  it("preserves declared service and migration processes and leaves other services alone", () => {
    const declaration = {
      command: ["node", "worker.mjs"],
      args: ["--x", "quoted value"],
      secretRefs: [{ key: "DATABASE_SERVICE_URL" }],
    };
    expect(databaseConsumerCommand(declaration).args).toEqual([
      ...declaration.command,
      ...declaration.args,
    ]);
    expect(databaseConsumerCommand({ ...declaration, secretRefs: [] })).toEqual(
      { command: declaration.command, args: declaration.args }
    );
  });
});

describe("a node app migrates its own databases before it serves (task.5408)", () => {
  /**
   * Runs the wrapper with a fake `node` first on PATH: it records argv, DATABASE_URL, NODE_NAME and
   * whether a CA file is trusted, and exits with FAIL_ON's code when its argv names that migrator.
   * The app itself is `sh -c` printing whether the migration DSN survived into its env.
   */
  function run(env: Record<string, string>, refs: readonly string[]) {
    const dir = mkdtempSync(join(tmpdir(), "cogni-migrate-"));
    const log = join(dir, "log");
    writeFileSync(log, "");
    writeFileSync(
      join(dir, "node"),
      [
        "#!/bin/sh",
        `printf '%s|url=%s|node=%s|ca=%s\\n' "$*" "$DATABASE_URL" "$NODE_NAME" "\${NODE_EXTRA_CA_CERTS:+yes}" >> "${log}"`,
        'case "$*" in *"$FAIL_ON"*) [ -n "$FAIL_ON" ] && exit 7 ;; esac',
        "exit 0",
      ].join("\n")
    );
    chmodSync(join(dir, "node"), 0o755);
    const start = databaseConsumerCommand({
      runtimeProfile: "cogni-node-app-v1",
      command: [
        "/bin/sh",
        "-c",
        `echo "app|migration=\${DATABASE_MIGRATION_URL:-unset}" >> "${log}"`,
      ],
      secretRefs: refs.map((key) => ({ key })),
    });
    const [exe, ...rest] = [...(start.command ?? []), ...(start.args ?? [])];
    if (!exe) throw new Error("no command");
    const result = spawnSync(exe, rest, {
      env: {
        NODE_ENV: "test",
        PATH: `${dir}:/usr/bin:/bin`,
        FAIL_ON: "",
        ...env,
      },
      encoding: "utf8",
    });
    return {
      status: result.status,
      lines: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
    };
  }

  const BASE = {
    NODE_NAME: "node-template",
    DATABASE_URL: "postgres://app",
    DATABASE_MIGRATION_URL: "postgres://migration",
    DATABASE_SSL_CA_CERT: rootCertificates[0] ?? "",
  };
  const REFS = ["DATABASE_URL", "DATABASE_MIGRATION_URL", "DOLTGRES_URL"];

  it("runs Postgres then Doltgres with their own DSNs, NODE_NAME and the CA, then execs the app without the migration DSN", () => {
    const out = run({ ...BASE, DOLTGRES_URL: "postgres://dolt" }, REFS);
    expect(out.status).toBe(0);
    expect(out.lines).toEqual([
      "/app/app/migrate.mjs /app/app/migrations|url=postgres://migration|node=node-template|ca=yes",
      "/app/app/migrate-doltgres.mjs /app/app/doltgres-migrations|url=postgres://dolt|node=node-template|ca=yes",
      "app|migration=unset",
    ]);
  });

  it("skips Doltgres when the node has no DOLTGRES_URL", () => {
    const out = run(BASE, REFS);
    expect(out.status).toBe(0);
    expect(out.lines).toEqual([
      "/app/app/migrate.mjs /app/app/migrations|url=postgres://migration|node=node-template|ca=yes",
      "app|migration=unset",
    ]);
  });

  it.each([
    "migrate.mjs",
    "migrate-doltgres.mjs",
  ])("a failing %s stops the container before the app starts", (failing) => {
    const out = run(
      { ...BASE, DOLTGRES_URL: "postgres://dolt", FAIL_ON: failing },
      REFS
    );
    expect(out.status).not.toBe(0);
    expect(out.lines.some((l) => l.startsWith("app|"))).toBe(false);
  });

  it("refuses to start without NODE_NAME (both migrators require it)", () => {
    const { NODE_NAME: _omit, ...noName } = BASE;
    const out = run(noName, REFS);
    expect(out.status).not.toBe(0);
    expect(out.lines).toEqual([]);
  });

  it("migrates only a node app given the migration DSN; other wrappers are unchanged", () => {
    const withoutKey = databaseConsumerCommand({
      runtimeProfile: "cogni-node-app-v1",
      secretRefs: [{ key: "DATABASE_URL" }],
    });
    expect(withoutKey.command?.[2]).not.toContain("migrate.mjs");
    const notNodeApp = databaseConsumerCommand({
      command: ["node", "worker.mjs"],
      secretRefs: [{ key: "DATABASE_MIGRATION_URL" }],
    });
    expect(notNodeApp.command?.[2]).not.toContain("migrate.mjs");
    expect(withDatabaseCaTrust(["node", "x"]).command[2]).not.toContain(
      "migrate.mjs"
    );
  });
});
