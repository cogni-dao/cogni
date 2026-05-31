// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/components/CTASection`
 * Purpose: Homepage call-to-action section with final conversion prompt.
 * Scope: Feature component that renders bottom CTA using kit components. Does not handle styling.
 * Invariants: Uses kit components only; provides content and data only.
 * Side-effects: none
 * Notes: Uses CtaSection kit component with homepage-specific content.
 * Links: src/components/kit/sections/CtaSection.tsx
 * @public
 */

import { ArrowRight } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components";
import { CtaSection as CtaSectionKit } from "@/components/kit/sections";

export function HomeCtaSection(): ReactElement {
  return (
    <CtaSectionKit
      surface="muted"
      heading="Ready to build autonomous AI?"
      paragraph="Our template provides everything you need for crypto-funded, AI-powered organizations. Focus on your domain logic, not infrastructure."
      action={
        <a
          href="https://github.com/cogni-template/cogni-template"
          target="_blank"
          rel="noopener"
        >
          <Button size="lg" variant="outline">
            View the code
            <ArrowRight />
          </Button>
        </a>
      }
    />
  );
}
