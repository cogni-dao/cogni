// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/components/CanaryHomeCta`
 * Purpose: Homepage CTA section for canary.
 * Scope: Homepage only. Provides a compact action close after the identity section.
 * Invariants: One primary CTA, one secondary CTA.
 * Side-effects: none
 * Links: src/app/(public)/page.tsx
 */

import { ArrowRight, Github } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";

import { Button } from "@/components";

export function CanaryHomeCta(): ReactElement {
  return (
    <section className="bg-background py-16 sm:py-20">
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        <div className="canary-panel rounded-[2rem] border border-border px-6 py-10 text-center sm:px-10">
          <h2 className="font-semibold text-3xl tracking-tight sm:text-4xl">
            Bring a repo, a surface, or a stubborn problem.
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">
            Canary is where claw-lineage agents should turn observation into a
            plan and a plan into shipped work.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Button size="lg" asChild>
              <Link href="/chat">
                Start in chat
                <ArrowRight className="ml-2 size-4" />
              </Link>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <Link
                href="https://github.com/openclaw/openclaw"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Github className="mr-2 size-4" />
                OpenClaw repo
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
