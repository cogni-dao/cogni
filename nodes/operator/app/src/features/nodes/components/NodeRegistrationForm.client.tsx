// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/components/NodeRegistrationForm`
 * Purpose: Shared client form for registering an operator-managed node.
 * Scope: Posts to the existing nodes API and routes to the canonical setup page for the new row.
 * Invariants: v0 only registers managed monorepo nodes on Base mainnet — no target selection.
 * Side-effects: IO (POST /api/v1/nodes)
 * Links: src/app/api/v1/nodes/route.ts, src/app/(app)/nodes/page.tsx
 * @public
 */

"use client";

import { ArrowRight, Code2, Landmark, Rocket } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, type ReactNode, useState } from "react";

import { Button } from "@/components";
import { CHAINS as CHAIN_CONFIG_MAP } from "@/shared/web3";

const CHAIN_ID = CHAIN_CONFIG_MAP.BASE.chainId;
const SLUG_RE = /^[a-z][a-z0-9-]{1,31}$/;

const OUTCOMES: ReadonlyArray<{
  icon: ReactNode;
  title: string;
  detail: string;
}> = [
  {
    icon: <Landmark className="h-5 w-5" />,
    title: "An on-chain organization",
    detail: "A DAO formed on Base to own and govern your node.",
  },
  {
    icon: <Code2 className="h-5 w-5" />,
    title: "A full app codebase",
    detail: "Your own repo, pinned and wired for deployment.",
  },
  {
    icon: <Rocket className="h-5 w-5" />,
    title: "An AI launch pack",
    detail:
      "Everything your AI developer needs to kickstart your deploys and dev lifecycle.",
  },
];

export function NodeRegistrationForm(): ReactElement {
  const router = useRouter();
  const [slug, setSlug] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slugValid = SLUG_RE.test(slug);

  const handleSubmit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/v1/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, chainId: CHAIN_ID }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.reason ?? body?.error ?? `HTTP ${res.status}`);
        return;
      }
      const { node } = await res.json();
      router.push(`/nodes/${node.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <p className="font-medium text-muted-foreground text-sm">
          Registering a node spins up:
        </p>
        <ul className="space-y-3">
          {OUTCOMES.map((o) => (
            <li key={o.title} className="flex items-start gap-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring ring-ring/20">
                {o.icon}
              </span>
              <div className="space-y-0.5 pt-0.5">
                <p className="font-medium text-sm leading-tight">{o.title}</p>
                <p className="text-muted-foreground text-sm leading-snug">
                  {o.detail}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col items-center gap-3 pt-2">
        <label className="font-medium text-sm" htmlFor="slug">
          Name your node
        </label>
        <div className="flex h-10 w-64 items-center rounded-md border border-input bg-background px-3 transition-colors focus-within:border-ring">
          <input
            id="slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            placeholder="my-node"
            className="h-full min-w-0 flex-1 bg-transparent text-right text-foreground text-sm outline-none placeholder:text-muted-foreground"
          />
          <span className="shrink-0 text-muted-foreground text-sm">
            .cognidao.org
          </span>
        </div>
        <p className="h-4 text-destructive text-xs">
          {slug && !slugValid
            ? "Lowercase letters, numbers and dashes, 2-32 chars."
            : (error ?? "")}
        </p>
        <Button
          className="w-64"
          variant="accent"
          size="lg"
          rightIcon={<ArrowRight />}
          onClick={handleSubmit}
          disabled={submitting || !slugValid}
        >
          {submitting ? "Registering..." : "Register node"}
        </Button>
      </div>
    </div>
  );
}
