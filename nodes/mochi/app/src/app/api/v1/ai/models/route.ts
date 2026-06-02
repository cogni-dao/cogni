// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/ai/models`
 * Purpose: Provides HTTP endpoint for listing available AI models from all providers.
 * Scope: Auth-protected GET endpoint that returns aggregated model list via ModelCatalogPort.
 * Invariants: Uses ModelCatalogPort (providers handle caching), validates with contract.
 * Side-effects: IO (HTTP request/response)
 * Links: ai.models.v1.contract, ModelCatalogPort, docs/spec/multi-provider-llm.md
 * @public
 */

import { aiModelsOperation, type Model } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getOrCreateBillingAccountForUser } from "@/lib/auth/mapping";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "ai.models", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, sessionUser) => {
    const startMs = performance.now();
    try {
      if (!sessionUser) throw new Error("sessionUser required");

      const container = getContainer();
      const accountService = container.accountsForUser(
        (await import("@cogni/ids")).toUserId(sessionUser.id)
      );
      const billingAccount = await getOrCreateBillingAccountForUser(
        accountService,
        {
          userId: sessionUser.id,
          ...(sessionUser.walletAddress
            ? { walletAddress: sessionUser.walletAddress }
            : {}),
        }
      );

      const { models, defaultRef } = await container.modelCatalog.listModels({
        userId: sessionUser.id,
        tenantId: billingAccount.id,
      });

      // Map ModelOption to contract Model
      const contractModels: Model[] = models.map((m) => ({
        ref: m.ref,
        label: m.label,
        requiresPlatformCredits: m.requiresPlatformCredits,
        providerLabel: m.providerLabel,
        capabilities: m.capabilities,
      }));

      const responseData = {
        models: contractModels,
        defaultRef,
      };

      // Validate output with contract
      const outputParseResult =
        aiModelsOperation.output.safeParse(responseData);
      if (!outputParseResult.success) {
        ctx.log.error(
          {
            errCode: "inv_models_contract_validation_failed",
            catalogSize: contractModels.length,
          },
          "Model data failed contract validation"
        );
        return NextResponse.json(
          { error: "Server error: invalid data format" },
          { status: 500 }
        );
      }

      ctx.log.info(
        {
          modelCount: contractModels.length,
          durationMs: performance.now() - startMs,
        },
        "ai.models_list_success"
      );

      return NextResponse.json(outputParseResult.data, { status: 200 });
    } catch (error) {
      ctx.log.error(
        {
          errCode: "ai.models_fetch_failed",
          errorType: error instanceof Error ? error.name : "unknown",
        },
        "Failed to fetch models"
      );
      return NextResponse.json(
        { error: "Failed to fetch models" },
        { status: 503 }
      );
    }
  }
);
