// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/components/CanaryHomeSignals`
 * Purpose: Content section describing what canary is for.
 * Scope: Homepage only. Communicates the node's operator value and brand lineage.
 * Invariants: Three-card grid; copy stays concise and action-oriented.
 * Side-effects: none
 * Links: src/app/(public)/page.tsx
 */

import { Eye, Search, Send, Shell } from "lucide-react";
import type { ReactElement } from "react";

const SIGNALS = [
  {
    icon: Eye,
    title: "Inspect live surfaces",
    copy: "Use canary to look at the real thing first — websites, product flows, PRs, runtime behavior, and the current state of work.",
  },
  {
    icon: Search,
    title: "Research before invention",
    copy: "Canary leans on the real claw family: OpenClaw's execution feel, ClawHub's skill model, and Molt's agent-native tone.",
  },
  {
    icon: Send,
    title: "Ship with operator pressure",
    copy: "The point is not a pretty dashboard. The point is faster loops from messy prompt to grounded, validated output.",
  },
] as const;

export function CanaryHomeSignals(): ReactElement {
  return (
    <section className="border-border border-b bg-background py-16 sm:py-20">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-4 sm:px-6">
        <div className="max-w-3xl space-y-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-sm text-muted-foreground">
            <Shell className="size-4 text-primary" />
            what lives here
          </div>
          <h2 className="font-semibold text-3xl tracking-tight sm:text-4xl">
            Built for agent work that needs context, judgment, and follow-through.
          </h2>
          <p className="text-lg text-muted-foreground">
            Canary should feel like it belongs to the same family as OpenClaw,
            ClawHub, and Moltbook — dark shell, electric signal, high-agency
            tone, and no generic startup hero filler.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          {SIGNALS.map((signal) => (
            <article
              key={signal.title}
              className="canary-panel rounded-3xl border border-border p-6"
            >
              <div className="flex size-10 items-center justify-center rounded-2xl border border-border bg-background/80 text-primary">
                <signal.icon className="size-5" />
              </div>
              <h3 className="mt-4 font-medium text-xl">{signal.title}</h3>
              <p className="mt-2 text-muted-foreground">{signal.copy}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
