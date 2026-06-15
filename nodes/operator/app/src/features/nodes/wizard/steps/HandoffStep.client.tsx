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
import { Button } from "@/components";
import { LaunchPackCopyButton } from "../LaunchPackCopyButton.client";
import { StepSection } from "../StepSection";
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
    <StepSection title="Ready for your AI developer">
      <div className="space-y-6 text-sm">
        {/* Primary CTA — centered, accent, front and center */}
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <LaunchPackCopyButton
            nodeId={node.id}
            variant="default"
            size="xl"
            className="gap-2"
            label="Copy your AI-dev prompt"
          />
          <p className="text-muted-foreground text-xs">
            Paste it to your AI developer to start building.
          </p>
        </div>

        <p className="text-muted-foreground">
          This is where development begins — not the finish line. Your node's
          scaffolding exists; your AI dev takes it from here and gets it live:{" "}
          <span className="text-foreground">
            deploy to test → promote to preview → promote to production
          </span>{" "}
          (a few steps).
        </p>

        <p className="text-muted-foreground">
          Everything below is what you just created — all useful, but you don't
          need to save it. The one that matters:{" "}
          <span className="text-foreground">open your node repo</span> and get
          it running in your workspace.
        </p>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {links.map((link, i) => (
            <Button
              key={link.label}
              asChild
              size="xl"
              variant={i === 0 ? "default" : "outline"}
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
    </StepSection>
  );
}
