// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { execFileSync } from "node:child_process";
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
        env: { DATABASE_SSL_CA_CERT: rootCertificates[0] },
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
