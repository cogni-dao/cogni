// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/version`
 * Purpose: HTTP endpoint providing build version metadata for artifact verification.
 * Scope: Returns version, git SHA, and build timestamp. Unauthenticated, no dependencies.
 * Invariants: Always returns valid version schema; force-dynamic runtime.
 * Side-effects: IO (HTTP response)
 * Notes: Used for artifact verification, debugging, and CI/CD pipelines.
 *        Aligns with /readyz buildSha and /metrics app_build_info gauge.
 * Links: `@contracts/meta.version.read.v1.contract`, src/app/(infra)/readyz/route.ts
 * @public
 */

import { metaVersionOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const env = serverEnv();

  const payload = {
    version:
      // biome-ignore lint/style/noProcessEnv: build-time constant from npm_package_version
      process.env.npm_package_version || "unknown",
    buildSha: env.APP_BUILD_SHA || undefined,
    // biome-ignore lint/style/noProcessEnv: build-time constant
    buildTime: process.env.BUILD_TIME || undefined,
  };

  const parsed = metaVersionOperation.output.parse(payload);
  return NextResponse.json(parsed);
}
