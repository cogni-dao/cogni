// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/GraphView`
 * Purpose: 3D force-directed view of the knowledge hub — domains as hub nodes,
 *   entries clustered around them, citation edges colored by type. Clicking an
 *   entry opens the shared KnowledgeDetail side-sheet (same panel the table uses).
 * Scope: Client presentation. Fetches GET /api/v1/knowledge/graph via React Query;
 *   resolves clicked node → full KnowledgeRow from the parent-loaded list.
 * Invariants:
 *   - SSR_DISABLED (react-force-graph-3d touches window; dynamic import ssr:false).
 *   - SIDE_SHEET_REUSE (node click → KnowledgeDetail, not a bespoke panel).
 * Side-effects: IO (graph fetch), WebGL render.
 * Links: docs/spec/knowledge-syntropy.md
 * @internal
 */

"use client";

import type { KnowledgeRow } from "@cogni/node-contracts";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import {
  type ComponentType,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { fetchGraph } from "../_api/fetchGraph";
import { KnowledgeDetail } from "./KnowledgeDetail";

interface GraphNodeObject {
  id: string;
  isHub: boolean;
  domain: string;
  title: string;
  entryType?: string;
  confidencePct?: number | null;
  sourceType?: string;
  entryCount?: number;
}

interface GraphLinkObject {
  source: string;
  target: string;
  kind: "member" | "cite";
  citationType?: string;
}

// Only the props we use. `next/dynamic` erases the lib's own generic prop types,
// so we re-declare them over our node/link shapes — keeps the JSX strongly typed.
interface ForceGraph3DProps {
  readonly graphData: {
    nodes: GraphNodeObject[];
    links: GraphLinkObject[];
  };
  readonly width?: number;
  readonly height?: number;
  readonly backgroundColor?: string;
  readonly showNavInfo?: boolean;
  readonly nodeColor?: (node: GraphNodeObject) => string;
  readonly nodeVal?: (node: GraphNodeObject) => number;
  readonly nodeLabel?: (node: GraphNodeObject) => string;
  readonly nodeOpacity?: number;
  readonly nodeResolution?: number;
  readonly linkColor?: (link: GraphLinkObject) => string;
  readonly linkWidth?: (link: GraphLinkObject) => number;
  readonly linkDirectionalParticles?: (link: GraphLinkObject) => number;
  readonly linkDirectionalParticleWidth?: number;
  readonly linkDirectionalArrowLength?: (link: GraphLinkObject) => number;
  readonly linkDirectionalArrowRelPos?: number;
  readonly onNodeClick?: (node: GraphNodeObject) => void;
}

// react-force-graph-3d reaches for `window` at module load — keep it client-only.
const ForceGraph3D = dynamic(() => import("react-force-graph-3d"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
      Loading 3D engine…
    </div>
  ),
}) as unknown as ComponentType<ForceGraph3DProps>;

// Mirrors ChainPanel.tsx chipFor() edge semantics.
const CITE_COLOR: Record<string, string> = {
  supports: "#34d399",
  validates: "#34d399",
  evidence_for: "#7dd3fc",
  extends: "#6ea8fe",
  derives_from: "#6ea8fe",
  supersedes: "#fbbf24",
  contradicts: "#f87171",
  invalidates: "#f87171",
};

// Confidence → hue ramp across the red→green arc of the HSL wheel:
// hue = pct * 1.2, so 0 = red, ~30 = orange, ~50 = yellow, 100 = green.
function confidenceColor(pct: number): string {
  const p = Math.max(0, Math.min(100, pct));
  return `hsl(${Math.round(p * 1.2)}, 80%, 55%)`;
}

// Domain hubs are structural anchors, not a classifier — render them neutral so
// the entries' confidence hue is the only color signal.
const HUB_COLOR = "#94a3b8";

// nodeLabel is injected as HTML by the graph lib; knowledge titles/ids are
// agent- and externally-authored (untrusted), so escape before interpolation.
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

export function GraphView({ rows }: { readonly rows: KnowledgeRow[] }) {
  const graphQuery = useQuery({
    queryKey: ["knowledge", "graph"],
    queryFn: fetchGraph,
    staleTime: 30_000,
  });

  const [showHubs, setShowHubs] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rowsById = useMemo(() => {
    const m = new Map<string, KnowledgeRow>();
    for (const r of rows) m.set(r.id, r);
    return m;
  }, [rows]);

  const data = useMemo<{
    nodes: GraphNodeObject[];
    links: GraphLinkObject[];
  }>(() => {
    const g = graphQuery.data;
    if (!g) return { nodes: [], links: [] };
    const domains = [...new Set(g.nodes.map((n) => n.domain))];
    const hubs: GraphNodeObject[] = showHubs
      ? domains.map((d) => ({
          id: `domain:${d}`,
          isHub: true,
          domain: d,
          title: d,
          entryCount: g.nodes.filter((n) => n.domain === d).length,
        }))
      : [];
    const entries: GraphNodeObject[] = g.nodes.map((n) => ({
      id: n.id,
      isHub: false,
      domain: n.domain,
      title: n.title,
      entryType: n.entryType,
      confidencePct: n.confidencePct,
      sourceType: n.sourceType,
    }));
    const links: GraphLinkObject[] = [];
    if (showHubs) {
      for (const n of g.nodes) {
        links.push({
          source: `domain:${n.domain}`,
          target: n.id,
          kind: "member",
        });
      }
    }
    for (const e of g.edges) {
      links.push({
        source: e.source,
        target: e.target,
        kind: "cite",
        citationType: e.citationType,
      });
    }
    return { nodes: [...hubs, ...entries], links };
  }, [graphQuery.data, showHubs]);

  const nodeColor = useCallback((node: GraphNodeObject) => {
    if (node.isHub) return HUB_COLOR;
    return confidenceColor(node.confidencePct ?? 40);
  }, []);

  const nodeVal = useCallback((node: GraphNodeObject) => {
    if (node.isHub) return 22;
    return 2 + (node.confidencePct ?? 40) / 22;
  }, []);

  const nodeLabel = useCallback((node: GraphNodeObject) => {
    if (node.isHub) {
      return `<b>${escapeHtml(node.domain)}</b> · ${node.entryCount} entries`;
    }
    const meta = `${escapeHtml(node.id)} · ${escapeHtml(node.entryType ?? "")} · ${node.confidencePct ?? "?"}%`;
    return `<div style="max-width:240px"><b>${escapeHtml(node.title)}</b><br/><span style="opacity:.6">${meta}</span></div>`;
  }, []);

  const linkColor = useCallback((link: GraphLinkObject) => {
    if (link.kind === "member") return "rgba(120,128,140,.18)";
    return CITE_COLOR[link.citationType ?? ""] ?? "#9aa0aa";
  }, []);

  const onNodeClick = useCallback((node: GraphNodeObject) => {
    if (node.isHub) return;
    setSelectedId(node.id);
  }, []);

  // Size the WebGL canvas to its container (the lib defaults to window size).
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const selectedItem = selectedId ? (rowsById.get(selectedId) ?? null) : null;

  if (graphQuery.error) {
    return (
      <p className="py-8 text-center text-destructive">
        Failed to load knowledge graph.
      </p>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-muted-foreground text-xs">
          Node color = confidence (red → green)
        </span>
        <label className="flex cursor-pointer items-center gap-2 text-muted-foreground text-xs">
          <input
            type="checkbox"
            checked={showHubs}
            onChange={(e) => setShowHubs(e.target.checked)}
            className="size-3.5 accent-primary"
          />
          Domain hubs
        </label>
        <span className="ml-auto text-muted-foreground text-xs">
          {graphQuery.data
            ? `${graphQuery.data.nodes.length} entries · ${graphQuery.data.edges.length} citations`
            : "Loading graph…"}
        </span>
      </div>

      <div
        ref={wrapRef}
        className="relative h-[70vh] w-full overflow-hidden rounded-lg border border-border/60 bg-background"
      >
        {graphQuery.data && (
          <ForceGraph3D
            graphData={data}
            width={size.width}
            height={size.height}
            backgroundColor="rgba(0,0,0,0)"
            showNavInfo={false}
            nodeColor={nodeColor}
            nodeVal={nodeVal}
            nodeLabel={nodeLabel}
            nodeOpacity={0.92}
            nodeResolution={12}
            linkColor={linkColor}
            linkWidth={(l: GraphLinkObject) => (l.kind === "cite" ? 1.2 : 0.4)}
            linkDirectionalParticles={(l: GraphLinkObject) =>
              l.kind === "cite" ? 2 : 0
            }
            linkDirectionalParticleWidth={1.4}
            linkDirectionalArrowLength={(l: GraphLinkObject) =>
              l.kind === "cite" ? 2.5 : 0
            }
            linkDirectionalArrowRelPos={1}
            onNodeClick={onNodeClick}
          />
        )}
        <GraphLegend edges={graphQuery.data?.edges ?? []} />
      </div>

      <KnowledgeDetail
        item={selectedItem}
        open={selectedItem !== null}
        showChain
        onOpenChange={(o) => {
          if (!o) setSelectedId(null);
        }}
      />
    </>
  );
}

function GraphLegend({
  edges,
}: {
  readonly edges: ReadonlyArray<{ citationType: string }>;
}) {
  const citeTypes = [...new Set(edges.map((e) => e.citationType))];
  const ramp = [0, 25, 50, 75, 100];
  return (
    <div className="absolute bottom-3 left-3 max-w-[220px] rounded-lg border border-border/60 bg-background/80 p-3 backdrop-blur">
      <p className="mb-1.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
        Confidence
      </p>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">0</span>
        <span className="flex">
          {ramp.map((p) => (
            <span
              key={p}
              className="size-2.5"
              style={{ backgroundColor: confidenceColor(p) }}
            />
          ))}
        </span>
        <span className="text-muted-foreground">100</span>
      </div>
      {citeTypes.length > 0 && (
        <>
          <p className="mt-2 mb-1.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
            Citations
          </p>
          {citeTypes.slice(0, 8).map((ct) => (
            <div key={ct} className="flex items-center gap-2 text-xs">
              <span
                className="h-0 w-4 border-t-2"
                style={{ borderColor: CITE_COLOR[ct] ?? "#9aa0aa" }}
              />
              {ct}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
