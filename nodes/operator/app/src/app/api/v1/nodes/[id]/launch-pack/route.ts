// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/launch-pack`
 * Purpose: Preserve the published legacy launch packet for existing callers.
 * Scope: Owner-gated read; shared input assembly, legacy output validation.
 * Side-effects: IO (session, owner-scoped node read and correlated logs)
 * Links: src/app/_lib/node-launch-pack-read.ts, nodes.launch-pack.v1.contract.ts
 * @public
 */

import { NextResponse } from "next/server";

import {
  type NodeLaunchPackReadContext,
  readNodeLaunchPackInput,
} from "@/app/_lib/node-launch-pack-read";
import { nodeLaunchPackOperation } from "@/contracts/nodes.launch-pack.v1.contract";
import { buildNodeLaunchPack } from "@/features/nodes/launch-pack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: NodeLaunchPackReadContext
) {
  const result = await readNodeLaunchPackInput(request, context);
  if (result.status === "error") return result.response;
  return NextResponse.json(
    nodeLaunchPackOperation.output.parse(buildNodeLaunchPack(result.input))
  );
}
