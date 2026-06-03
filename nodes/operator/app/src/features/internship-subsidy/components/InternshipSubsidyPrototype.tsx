// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/internship-subsidy/components/InternshipSubsidyPrototype`
 * Purpose: Public prototype UI for comparing Allo and Sablier subsidy rails.
 * Scope: Client component that reads the public prototype API and renders the selected rail plan.
 * Invariants: no wallet signing; no transaction submission.
 * Side-effects: IO (fetch public API), browser state
 * Links: app/api/v1/public/internship-subsidy/prototype/route.ts
 * @public
 */

"use client";

import { cn } from "@cogni/node-ui-kit/util/cn";
import {
  ArrowRight,
  BadgeDollarSign,
  CircleDollarSign,
  GitBranch,
  Landmark,
  ShieldCheck,
} from "lucide-react";
import { type ReactElement, useEffect, useMemo, useState } from "react";
import { Button } from "@/components";
import type {
  InternshipSubsidyPrototypeOutput,
  SubsidyRail,
} from "@/contracts/internship.subsidy-prototype.v1.contract";

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function formatUsd(cents: number): string {
  return currency.format(cents / 100);
}

function timingLabel(timing: string): string {
  return timing.replaceAll("_", " ");
}

export function InternshipSubsidyPrototype(): ReactElement {
  const [rail, setRail] = useState<SubsidyRail>("allo");
  const [data, setData] = useState<InternshipSubsidyPrototypeOutput | null>(
    null
  );
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading"
  );

  const endpoint = useMemo(
    () =>
      `/api/v1/public/internship-subsidy/prototype?rail=${encodeURIComponent(
        rail
      )}`,
    [rail]
  );

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    fetch(endpoint)
      .then((response) => {
        if (!response.ok) throw new Error("prototype request failed");
        return response.json() as Promise<InternshipSubsidyPrototypeOutput>;
      })
      .then((nextData) => {
        if (cancelled) return;
        setData(nextData);
        setStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  const railOptions = data?.railOptions ?? [
    {
      rail: "allo" as const,
      label: "Allo Protocol grant pool",
      fit: "recommended" as const,
    },
    {
      rail: "sablier-flow" as const,
      label: "Sablier Flow stream",
      fit: "viable" as const,
    },
  ];

  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="border-border/70 border-b bg-muted px-4 py-20 sm:px-6 lg:py-24">
        <div className="mx-auto max-w-6xl">
          <div className="max-w-3xl">
            <span className="font-mono text-muted-foreground text-xs uppercase tracking-widest">
              OSS-first distribution prototype
            </span>
            <h1 className="mt-4 font-bold text-4xl tracking-tight sm:text-6xl">
              Intern AI subscription subsidy fund
            </h1>
            <p className="mt-5 max-w-2xl text-lg text-muted-foreground leading-relaxed">
              A DAO-funded USDC program that pays fixed $200 increments after
              interview, identity, and contribution gates while keeping protocol
              mechanics behind a swappable rail adapter.
            </p>
          </div>

          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {[
              {
                icon: CircleDollarSign,
                label: "Increment",
                value: data
                  ? formatUsd(data.program.incrementUsdCents)
                  : "$200",
              },
              {
                icon: BadgeDollarSign,
                label: "Prototype pool",
                value: data
                  ? formatUsd(data.program.poolAmountUsdCents)
                  : "$3,000",
              },
              {
                icon: ShieldCheck,
                label: "Contracts owned",
                value: "Zero custom",
              },
            ].map(({ icon: Icon, label, value }) => (
              <div
                key={label}
                className="rounded-lg border border-border/70 bg-card p-5 shadow-sm"
              >
                <Icon className="mb-4 size-5 text-foreground" />
                <div className="font-mono text-muted-foreground text-xs uppercase tracking-widest">
                  {label}
                </div>
                <div className="mt-2 font-semibold text-2xl">{value}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-4 py-16 sm:px-6">
        <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-4">
          <aside className="space-y-3 lg:col-span-1">
            {railOptions.map((option) => (
              <Button
                key={option.rail}
                type="button"
                variant={rail === option.rail ? "default" : "outline"}
                className="h-auto w-full justify-start px-4 py-3 text-left"
                onClick={() => setRail(option.rail)}
              >
                <GitBranch className="mr-3 size-4 shrink-0" />
                <span>
                  <span className="block">{option.label}</span>
                  <span
                    className={cn(
                      "block font-normal text-xs",
                      rail === option.rail
                        ? "text-primary-foreground/75"
                        : "text-muted-foreground"
                    )}
                  >
                    {option.fit}
                  </span>
                </span>
              </Button>
            ))}
          </aside>

          <div className="space-y-6 lg:col-span-3">
            {status === "error" ? (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-5 text-destructive">
                Prototype failed to load.
              </div>
            ) : null}

            <div className="rounded-lg border border-border/70 bg-card p-6 shadow-sm">
              <div className="mb-4 flex items-center gap-3">
                <Landmark className="size-5" />
                <span className="font-mono text-muted-foreground text-xs uppercase tracking-widest">
                  Selected rail
                </span>
              </div>
              <h2 className="font-semibold text-2xl">
                {data?.selectedRail.label ?? "Loading rail"}
              </h2>
              <p className="mt-3 text-muted-foreground">
                {data?.program.managerLegalActor ?? "Loading manager profile"}
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {(data?.selectedRail.contractSurface ?? ["Loading"]).map(
                  (item) => (
                    <span
                      key={item}
                      className="rounded-md border border-border bg-background px-3 py-1 text-sm"
                    >
                      {item}
                    </span>
                  )
                )}
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="rounded-lg border border-border/70 bg-card p-6 shadow-sm">
                <h3 className="font-semibold text-xl">Execution path</h3>
                <div className="mt-5 space-y-4">
                  {(data?.selectedRail.actions ?? []).map((action) => (
                    <div key={action.id} className="flex gap-3">
                      <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
                      <div>
                        <div className="font-medium">{action.label}</div>
                        <div className="mt-1 text-muted-foreground text-sm">
                          {action.details}
                        </div>
                        <div className="mt-2 font-mono text-muted-foreground text-xs uppercase tracking-widest">
                          {action.actor} · {timingLabel(action.timing)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-border/70 bg-card p-6 shadow-sm">
                <h3 className="font-semibold text-xl">Milestone schedule</h3>
                <div className="mt-5 space-y-3">
                  {(data?.program.milestones ?? []).map((milestone) => (
                    <div
                      key={milestone.id}
                      className="rounded-md border border-border bg-background p-4"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <span className="font-medium">{milestone.label}</span>
                        <span className="font-semibold">
                          {formatUsd(milestone.amountUsdCents)}
                        </span>
                      </div>
                      <div className="mt-2 font-mono text-muted-foreground text-xs uppercase tracking-widest">
                        {milestone.gate.replaceAll("_", " ")}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="rounded-lg border border-border/70 bg-card p-6 shadow-sm">
                <h3 className="font-semibold text-xl">Cogni owns</h3>
                <ul className="mt-4 space-y-3 text-muted-foreground text-sm">
                  {(data?.selectedRail.cogniResponsibilities ?? []).map(
                    (item) => (
                      <li key={item}>{item}</li>
                    )
                  )}
                </ul>
              </div>
              <div className="rounded-lg border border-border/70 bg-card p-6 shadow-sm">
                <h3 className="font-semibold text-xl">Cogni avoids</h3>
                <ul className="mt-4 space-y-3 text-muted-foreground text-sm">
                  {(data?.selectedRail.avoidedResponsibilities ?? []).map(
                    (item) => (
                      <li key={item}>{item}</li>
                    )
                  )}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
