// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/steps/HandoffStep.client`
 * Purpose: The keeper — agent launch-pack handoff. Preserves the prior `published` content
 *   (copy/paste agent prompt + created-artifact links) and adds the Aragon DAO link.
 * Scope: Presentational + clipboard (via LaunchPackCopyButton). No new business logic.
 * Side-effects: none (LaunchPackCopyButton owns its fetch)
 * Links: src/features/nodes/wizard/LaunchPackCopyButton.client.tsx
 * @public
 */

"use client";

import { ExternalLink } from "lucide-react";
import type { ReactElement } from "react";
import { Button, SectionCard } from "@/components";
import { LaunchPackCopyButton } from "../LaunchPackCopyButton.client";
import type { WizardStepProps } from "../types";

interface LinkSpec {
  readonly label: string;
  readonly href: string;
}

export function HandoffStep({ node }: WizardStepProps): ReactElement {
  const links: LinkSpec[] = [
    ...(node.nodeRepoUrl
      ? [{ label: "Node repo", href: node.nodeRepoUrl }]
      : []),
    ...(node.knowledgeRepoUrl
      ? [{ label: "DoltHub repo", href: node.knowledgeRepoUrl }]
      : []),
    ...(node.publishPrUrl
      ? [{ label: "Deployment PR", href: node.publishPrUrl }]
      : []),
    ...(node.daoUrl ? [{ label: "Aragon DAO", href: node.daoUrl }] : []),
  ];

  return (
    <SectionCard title="Hand off to your AI developer">
      <div className="space-y-5 text-sm">
        <div className="space-y-2">
          <p className="font-medium text-base text-foreground">
            Launch pack ready.
          </p>
          <p className="text-muted-foreground">
            your node is almost ready. copy paste this to your AI developer, and
            they'll guide you from here.
          </p>
        </div>

        <LaunchPackCopyButton nodeId={node.id} />

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {links.map((link) => (
            <Button
              key={link.label}
              asChild
              size="xl"
              variant="outline"
              className="w-full"
            >
              <a href={link.href} target="_blank" rel="noopener noreferrer">
                {link.label}
                <ExternalLink className="size-4" />
              </a>
            </Button>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}
