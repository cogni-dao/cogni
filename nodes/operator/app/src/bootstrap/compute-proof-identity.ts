// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Optional private-process public identity. No web env, secret bank or Git resolver.
 * The operator image packages this fixed repo-spec under its /app working directory.
 * Repository is the same explicit operator composition pin used by the web process.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export function optionalComputeProofIdentity(
  readPublicSpec: () => string = () =>
    readFileSync(resolve("nodes/operator/.cogni/repo-spec.yaml"), "utf8")
): { nodeId: string; repository: string } | undefined {
  try {
    const spec = z
      .object({ node_id: z.string().uuid() })
      .parse(parse(readPublicSpec()));
    return { nodeId: spec.node_id, repository: "cogni-dao/cogni" };
  } catch {
    return undefined;
  } // Missing optional evidence never prevents wallet/health listen.
}
