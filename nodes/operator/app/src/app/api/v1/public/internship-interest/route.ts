// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/public/internship-interest`
 * Purpose: Public endpoint for internship interest submissions.
 * Scope: Validates recruitment interest payloads and emits a structured operator log event.
 * Invariants: VALIDATE_IO, PUBLIC_RATE_LIMITED, NO_DB_WRITE.
 * Side-effects: IO (HTTP response, structured log event)
 * Links: story.5001, contracts/internship.interest.v1.contract.ts
 * @public
 */

import { NextResponse } from "next/server";
import { verifyMessage } from "viem";
import { wrapPublicRoute } from "@/bootstrap/http";
import {
  buildInternshipApplicationMessage,
  internshipInterestOperation,
} from "@/contracts/internship.interest.v1.contract";
import { serverEnv } from "@/shared/env/server-env";
import { logRequestWarn } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapPublicRoute(
  {
    routeId: "internship.interest",
    cacheTtlSeconds: 0,
    staleWhileRevalidateSeconds: 0,
  },
  async (ctx, request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const parseResult = internshipInterestOperation.input.safeParse(body);
    if (!parseResult.success) {
      logRequestWarn(ctx.log, parseResult.error, "VALIDATION_ERROR");
      return NextResponse.json(
        { error: "invalid input", issues: parseResult.error.issues },
        { status: 400 }
      );
    }

    const input = parseResult.data;
    const expectedWalletMessage = buildInternshipApplicationMessage({
      email: input.email,
      portfolioUrl: input.portfolioUrl,
      focus: input.focus,
      interest: input.interest,
      walletSignedAt: input.walletSignedAt,
    });
    if (input.walletMessage !== expectedWalletMessage) {
      logRequestWarn(
        ctx.log,
        { walletAddress: input.walletAddress.toLowerCase() },
        "WALLET_MESSAGE_MISMATCH"
      );
      return NextResponse.json(
        { error: "wallet signature does not match application" },
        { status: 400 }
      );
    }

    const walletVerified = await verifyMessage({
      address: input.walletAddress as `0x${string}`,
      message: input.walletMessage,
      signature: input.walletSignature as `0x${string}`,
    });
    if (!walletVerified) {
      logRequestWarn(
        ctx.log,
        { walletAddress: input.walletAddress.toLowerCase() },
        "WALLET_SIGNATURE_INVALID"
      );
      return NextResponse.json(
        { error: "wallet signature does not match application" },
        { status: 400 }
      );
    }

    const referenceId = crypto.randomUUID();
    const derekInterviewUrl = serverEnv().DEREK_INTERVIEW_URL;
    const emailDomain =
      input.email.split("@").at(1)?.toLowerCase() ?? "unknown";

    ctx.log.info(
      {
        event: "internship.interest_submitted",
        referenceId,
        focus: input.focus,
        portfolioHost: new URL(input.portfolioUrl).host.toLowerCase(),
        walletAddress: input.walletAddress.toLowerCase(),
        walletSignedAt: input.walletSignedAt,
        emailDomain,
        interestLength: input.interest.length,
      },
      "internship interest submitted"
    );

    return NextResponse.json(
      internshipInterestOperation.output.parse({
        ok: true,
        referenceId,
        derekInterviewUrl,
      }),
      { status: 201 }
    );
  }
);
