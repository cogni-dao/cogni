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
import Link from "next/link";
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
        {/* What the human does — one paste, one approval. The AI dev does the rest. */}
        <p className="text-center text-muted-foreground">
          Hand this prompt to an AI developer that has a GitHub account{" "}
          <span className="text-foreground">(Claude Code, OpenClaw, …)</span>.
          It forks your node repo, ships a first change to a live test deploy,
          and reports back —{" "}
          <span className="text-foreground">
            your only step is to approve its access request
          </span>{" "}
          when it asks.
        </p>

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
          need to save them; your AI dev recovers what it needs from the prompt.
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

        <div className="flex justify-center pt-2">
          <Button asChild variant="outline" size="xl">
            <Link href={`/nodes/${node.id}/payments`}>Activate payments</Link>
          </Button>
        </div>
      </div>
    </StepSection>
  );
}
