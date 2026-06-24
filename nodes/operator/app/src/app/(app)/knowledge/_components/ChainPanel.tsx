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
import Link from "next/link";
import { useMemo } from "react";

import { Badge } from "@/components";

import { type ChainNodeDto, fetchChain } from "../_api/fetchChain";

interface ChainPanelProps {
  readonly rootId: string;
}

function ChainEntryChip({ node }: { readonly node: ChainNodeDto }) {
  const { entry, edgeFromParent } = node;
  const edgeLabel = edgeFromParent
    ? `${edgeFromParent.direction} ${edgeFromParent.citationType}`
    : "root";
  return (
    <Link href={`/knowledge/${encodeURIComponent(entry.id)}`}>
      <Badge intent="outline" size="sm">
        <span className="font-mono">{edgeLabel}</span>
        <span className="ml-1.5 font-mono text-muted-foreground">
          {entry.id}
        </span>
      </Badge>
    </Link>
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
        <ol className="flex flex-col gap-2">
          {byDepth.map(({ depth, nodes }) => (
            <li key={depth} className="flex flex-col gap-2">
              <span className="font-mono text-muted-foreground text-xs">
                depth {depth}
              </span>
              <ul className="flex flex-wrap gap-1.5">
                {nodes.map((node) => (
                  <li key={node.entry.id}>
                    <ChainEntryChip node={node} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
