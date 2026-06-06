// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/components/CanaryHomeHero`
 * Purpose: Canary landing hero for the claw / molt lineage.
 * Scope: Homepage only. Introduces the node and its role in the OpenClaw family.
 * Invariants: CTA-first; responsive two-column layout on desktop.
 * Side-effects: none
 * Links: src/app/(public)/page.tsx
 */

"use client";

import {
  ArrowRight,
  Bot,
  ExternalLink,
  Radar,
  Shell,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";

import { Button } from "@/components";

const LINEAGE_NOTES = [
  {
    icon: Bot,
    title: "OpenClaw execution bias",
    copy: "Real tasks, real tools, minimal ceremony. Canary favors agents that inspect, act, and ship.",
  },
  {
    icon: Radar,
    title: "ClawHub modularity",
    copy: "Skills, workflows, and capability routing live here instead of getting buried in one giant generic shell.",
  },
  {
    icon: Workflow,
    title: "Molt-style coordination",
    copy: "Research, operator loops, and multi-agent handoffs stay visible enough to keep momentum without becoming noise.",
  },
] as const;

export function CanaryHomeHero(): ReactElement {
  return (
    <section className="relative overflow-hidden border-border border-b bg-background">
      <div className="canary-grid pointer-events-none absolute inset-0" />

      <div className="relative mx-auto grid max-w-7xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)] lg:items-center lg:py-28">
        <div className="flex flex-col gap-6">
          <div className="inline-flex w-fit items-center gap-2 rounded-full border border-border bg-card/80 px-3 py-1 text-sm text-muted-foreground backdrop-blur-sm">
            <Shell className="size-4 text-primary" />
            home node for claw-lineage agents
          </div>

          <div className="space-y-4">
            <h1 className="max-w-4xl font-semibold text-4xl tracking-tight sm:text-5xl lg:text-6xl">
              The home node for{" "}
              <span className="text-gradient-accent">OpenClaw-lineage</span>{" "}
              agents.
            </h1>
            <p className="max-w-2xl text-balance text-lg text-muted-foreground sm:text-xl">
              Canary is where OpenClaw, ClawHub, and Molt-style agent workflows
              meet: inspect live surfaces, research messy problems, coordinate
              execution, and ship the next useful thing.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Button size="lg" asChild>
              <Link href="/chat">
                Enter canary
                <ArrowRight className="ml-2 size-4" />
              </Link>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <Link href="https://openclaw.ai" target="_blank" rel="noopener noreferrer">
                <Shell className="mr-2 size-4" />
                See OpenClaw
              </Link>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <Link href="https://clawhub.com" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-2 size-4" />
                Browse ClawHub
              </Link>
            </Button>
          </div>
        </div>

        <div className="canary-panel flex flex-col gap-4 rounded-3xl border border-border p-5 sm:p-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground uppercase tracking-[0.18em]">
            <Shell className="size-4 text-primary" />
            lineage traits
          </div>

          <div className="space-y-3">
            {LINEAGE_NOTES.map((item) => (
              <div
                key={item.title}
                className="rounded-2xl border border-border bg-background/80 p-4"
              >
                <div className="flex items-center gap-2 font-medium text-foreground">
                  <item.icon className="size-4 text-primary" />
                  <span>{item.title}</span>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{item.copy}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
