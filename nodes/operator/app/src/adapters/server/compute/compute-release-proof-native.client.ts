// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { readFile } from "node:fs/promises";
/** Fixed in-cluster GET/list/log transport. Socket close settles before admission reuse. */
import { request as httpsRequest } from "node:https";
import type { ProofKubeReadClient } from "@/ports/compute-release-proof.port";
export class InClusterProofKubeReadClient implements ProofKubeReadClient {
  constructor(
    private readonly server: string,
    private readonly ca: string,
    private readonly tokenFile: string
  ) {
    const u = new URL(server);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.pathname !== "/"
    )
      throw new Error("unavailable");
  }
  async json(path: string, signal: AbortSignal): Promise<unknown> {
    return JSON.parse(await this.get(path, signal, 1_048_576));
  }
  async log(path: string, signal: AbortSignal): Promise<string> {
    return this.get(path, signal, 65_536);
  }
  private async get(
    path: string,
    parent: AbortSignal,
    cap: number
  ): Promise<string> {
    parent.throwIfAborted();
    if (!path.startsWith("/apis/") && !path.startsWith("/api/"))
      throw new Error("unavailable");
    const token = (await readFile(this.tokenFile, "utf8")).trim();
    parent.throwIfAborted();
    const signal = AbortSignal.any([parent, AbortSignal.timeout(2000)]);
    return new Promise((resolve, reject) => {
      let result: string | undefined;
      let failure: unknown;
      let ended = false;
      const req = httpsRequest(
        new URL(path, this.server),
        {
          method: "GET",
          ca: this.ca,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          signal,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes >= cap) {
              failure = new Error("unavailable");
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", () => {
            failure = new Error("unavailable");
            req.destroy();
          });
          res.on("end", () => {
            ended = true;
            if (res.statusCode !== 200)
              failure = new Error(
                res.statusCode === 404 ? "absent" : "unavailable"
              );
            else result = Buffer.concat(chunks).toString("utf8");
          });
        }
      );
      req.on("error", () => {
        failure = new Error("unavailable");
      });
      req.on("close", () => {
        if (failure || !ended || signal.aborted)
          reject(
            new Error(
              failure instanceof Error && failure.message === "absent"
                ? "absent"
                : "unavailable"
            )
          );
        else resolve(result ?? "");
      });
      req.end();
    });
  }
}
