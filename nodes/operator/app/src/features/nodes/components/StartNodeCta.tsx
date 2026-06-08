// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/components/StartNodeCta`
 * Purpose: Public gallery CTA that routes users into authenticated node management.
 * Scope: Server-renderable link. Auth prompting is owned by proxy.ts and the public home
 *   sign-in intent handler.
 * Side-effects: none
 * Links: src/app/(public)/explore/nodes/page.tsx, src/proxy.ts
 * @public
 */

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";

import { Button } from "@/components";

export function StartNodeCta(): ReactElement {
  return (
    <Button asChild size="xl" className="px-8">
      <Link href="/nodes">
        Start a node
        <ArrowRight className="size-4" />
      </Link>
    </Button>
  );
}
