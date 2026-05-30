// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/ChainPanel`
 * Purpose: Render an EDO chain walk — root entry on top + flat list of related
 *   entries grouped by depth with citation-edge chips colored by type.
 * Scope: Pure presentation. Fetches via React Query against the chain DTO.
 * Invariants: Color discipline — validates green, invalidates red,
 *   derives_from blue, evidence_for neutral, supports neutral, contradicts red.
 * Side-effects: IO (GET /api/v1/edo/chain/:id via fetchChain)
 * Links: docs/spec/knowledge-syntropy.md § Chain Read API
 * @internal
 */

"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { Badge } from "@/components";

import { type ChainNodeDto, fetchChain } from "../_api/fetchChain";
import { ConfidenceBar } from "./ConfidenceBar";

type BadgeIntent = "default" | "secondary" | "destructive" | "outline";

interface ChainPanelProps {
  readonly rootId: string;
}

interface ChipStyle {
  readonly intent: BadgeIntent;
  readonly className?: string;
  readonly label: string;
}

function chipFor(citationType: string): ChipStyle {
  switch (citationType) {
    case "validates":
      return {
        intent: "default",
        // Override the primary palette with a green tint so the loop-closes
        // signal reads at a glance.
        className: "bg-success/15 text-success border-success/30 shadow-none",
        label: "validates",
      };
    case "invalidates":
      return {
        intent: "destructive",
        className: "bg-destructive/15 text-destructive border-destructive/30",
        label: "invalidates",
      };
    case "derives_from":
      return {
        intent: "default",
        className: "bg-info/15 text-info border-info/30 shadow-none",
        label: "derives_from",
      };
    case "evidence_for":
      return { intent: "outline", label: "evidence_for" };
    case "supports":
      return { intent: "secondary", label: "supports" };
    case "contradicts":
      return {
        intent: "destructive",
        className: "bg-destructive/10 text-destructive border-destructive/30",
        label: "contradicts",
      };
    case "extends":
      return { intent: "secondary", label: "extends" };
    case "supersedes":
      return { intent: "outline", label: "supersedes" };
    default:
      return { intent: "outline", label: citationType };
  }
}

function EdgeChip({
  citationType,
  direction,
}: {
  readonly citationType: string;
  readonly direction: "out" | "in";
}) {
  const style = chipFor(citationType);
  const arrow = direction === "out" ? "→" : "←";
  return (
    <Badge
      intent={style.intent}
      size="sm"
      {...(style.className ? { className: style.className } : {})}
    >
      <span className="font-mono">
        {arrow} {style.label}
      </span>
    </Badge>
  );
}

function EntryTypeChip({ entryType }: { readonly entryType: string | null }) {
  if (!entryType) return null;
  return (
    <Badge intent="outline" size="sm">
      <span className="font-mono">{entryType}</span>
    </Badge>
  );
}

export function ChainPanel({ rootId }: ChainPanelProps) {
  const chainQuery = useQuery({
    queryKey: ["edo-chain", rootId, "both", 5],
    queryFn: () => fetchChain(rootId, { direction: "both", maxDepth: 5 }),
    staleTime: 30_000,
  });

  const byDepth = useMemo(() => {
    if (!chainQuery.data)
      return [] as Array<{ depth: number; nodes: ChainNodeDto[] }>;
    const buckets = new Map<number, ChainNodeDto[]>();
    for (const node of chainQuery.data.chain) {
      const arr = buckets.get(node.depth) ?? [];
      arr.push(node);
      buckets.set(node.depth, arr);
    }
    return Array.from(buckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([depth, nodes]) => ({ depth, nodes }));
  }, [chainQuery.data]);

  if (chainQuery.isLoading) {
    return <p className="text-muted-foreground text-xs">Walking chain…</p>;
  }
  if (chainQuery.error) {
    return (
      <p className="text-destructive text-xs">
        Failed to walk chain: {(chainQuery.error as Error).message}
      </p>
    );
  }
  if (!chainQuery.data) return null;

  const total = chainQuery.data.chain.length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
          Chain ({total} {total === 1 ? "node" : "nodes"})
        </span>
      </div>
      {byDepth.length === 0 ||
      (byDepth.length === 1 && byDepth[0]?.nodes.length === 1) ? (
        <p className="text-muted-foreground text-xs">
          No connected entries. This row has no incoming or outgoing citations
          within the walk depth.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {byDepth.map(({ depth, nodes }) => (
            <li key={depth} className="flex flex-col gap-2">
              <span className="font-mono text-muted-foreground text-xs">
                depth {depth}
              </span>
              <ul className="flex flex-col gap-2">
                {nodes.map((node) => (
                  <ChainEntryCard key={node.entry.id} node={node} />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ChainEntryCard({ node }: { readonly node: ChainNodeDto }) {
  const { entry, edgeFromParent } = node;
  // entryType isn't on the chain DTO; the root component above doesn't carry
  // it either. We rely on the citation edge to convey the EDO role.
  return (
    <li className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-muted/10 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {edgeFromParent && (
          <EdgeChip
            citationType={edgeFromParent.citationType}
            direction={edgeFromParent.direction}
          />
        )}
        <EntryTypeChip entryType={inferEntryType(entry.id)} />
        <span className="font-mono text-muted-foreground text-xs">
          {entry.id}
        </span>
      </div>
      <div className="font-medium text-sm leading-snug">{entry.title}</div>
      {entry.confidencePct !== null && (
        <div className="flex items-center gap-2">
          <ConfidenceBar value={entry.confidencePct} width={80} />
        </div>
      )}
    </li>
  );
}

// The chain DTO does not currently carry entry_type on each node (the wire
// contract returns the same shape as KnowledgeEntry, which omits entry_type
// to match the existing capability output). Infer a best-effort label from
// the id prefix convention used by the EDO seeds (`proof:edo-decide-...`).
// This is presentational only; the canonical source is the citation edge.
function inferEntryType(id: string): string | null {
  if (id.includes("hypothesize") || id.includes("hypothesis"))
    return "hypothesis";
  if (id.includes("decide") || id.includes("decision")) return "decision";
  if (id.includes("outcome")) return "outcome";
  if (id.includes("event") || id.startsWith("evt:")) return "event";
  return null;
}
