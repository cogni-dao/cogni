// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/launch-pack/v2`
 * Purpose: Serve the canonical launch successor to the wizard's copy action.
 * Scope: Owner-gated read; shared input assembly, explicit v2 output validation.
 * Side-effects: IO (session, owner-scoped node read and correlated logs)
 * Links: src/app/_lib/node-launch-pack-read.ts, nodes.launch-pack.v2.contract.ts
 * @public
 */

import { NextResponse } from "next/server";

import {
  type NodeLaunchPackReadContext,
  readNodeLaunchPackInput,
} from "@/app/_lib/node-launch-pack-read";
import { nodeLaunchPackV2Operation } from "@/contracts/nodes.launch-pack.v2.contract";
import { buildNodeLaunchPackV2 } from "@/features/nodes/launch-pack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: NodeLaunchPackReadContext
) {
  const result = await readNodeLaunchPackInput(request, context);
  if (result.status === "error") return result.response;
  return NextResponse.json(
    nodeLaunchPackV2Operation.output.parse(buildNodeLaunchPackV2(result.input))
  );
}
