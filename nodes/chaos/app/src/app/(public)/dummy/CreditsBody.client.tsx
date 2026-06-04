// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/dummy/CreditsBody.client`
 * Purpose: Demo Credits page UI using new component system.
 * Scope: Reference implementation showing PageContainer, SectionCard, SplitInput, HintText composition. Static data only. Does not handle actual payment processing or backend interaction.
 * Invariants: Hardcoded balance; no actual payment processing.
 * Side-effects: none
 * Notes: Pattern to follow for real Credits page migration
 * Links: src/components/kit/layout/, src/components/kit/inputs/
 * @public
 */

"use client";

import { ExternalLink, Info } from "lucide-react";
import { useState } from "react";

import {
  Button,
  Card,
  HintText,
  PageContainer,
  SectionCard,
  SplitInput,
} from "@/components";

export function CreditsBody() {
  const [amount, setAmount] = useState("");

  const isValidAmount =
    amount !== "" && Number(amount) >= 1 && Number(amount) <= 100000;
  const showError = !isValidAmount;

  return (
    <PageContainer maxWidth="2xl">
      {/* Balance - just shadcn Card, no special component */}
      <Card className="flex items-center justify-between p-6">
        <span className="font-bold text-4xl">$ 30.64</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-9 rounded-full border border-border"
        >
          <Info size={20} />
        </Button>
      </Card>

      {/* Buy Credits Section */}
      <SectionCard title="Buy Credits">
        <SplitInput
          label="Amount"
          value={amount}
          onChange={(val) => setAmount(val.replace(/[^0-9]/g, ""))}
          placeholder="1 - 100000"
        />

        {showError ? (
          <div className="flex h-11 items-center justify-center rounded-lg border border-input bg-muted px-4">
            <p className="text-muted-foreground text-sm">Invalid amount</p>
          </div>
        ) : (
          <Button variant="default" size="lg" className="w-full">
            Purchase
          </Button>
        )}

        <HintText icon={<Info size={16} />}>
          Transactions may take many minutes to confirm
        </HintText>

        <a
          href="/usage"
          className="flex items-center gap-2 font-semibold text-primary text-sm hover:text-primary/80"
        >
          View Usage <ExternalLink size={16} />
        </a>
      </SectionCard>
    </PageContainer>
  );
}
