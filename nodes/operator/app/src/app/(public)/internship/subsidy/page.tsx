// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/internship/subsidy/page`
 * Purpose: Public prototype page for the intern AI subscription subsidy fund.
 * Scope: Renders the subsidy prototype UI; data comes from the public prototype API.
 * Invariants: unauthenticated; no wallet signing.
 * Side-effects: none
 * Links: features/internship-subsidy/components/InternshipSubsidyPrototype.tsx
 * @public
 */

import type { ReactElement } from "react";
import { InternshipSubsidyPrototype } from "@/features/internship-subsidy/public";

export default function InternshipSubsidyPage(): ReactElement {
  return <InternshipSubsidyPrototype />;
}
