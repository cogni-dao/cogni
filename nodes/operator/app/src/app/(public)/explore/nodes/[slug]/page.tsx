// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/explore/nodes/[slug]/page`
 * Purpose: Public detail page for one node's transparency read model.
 * Scope: Server component. Resolves detail data through the nodes facade.
 * Side-effects: IO (registry and metric reads through facade)
 * Links: task.5006, src/app/_facades/nodes/gallery.server.ts
 * @public
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactElement } from "react";

import { getNodeDetail } from "@/app/_facades/nodes/gallery.server";
import { NodeDetailView } from "@/features/nodes/components/NodeDetailView";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  readonly params: Promise<{ readonly slug: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const detail = await getNodeDetail(slug);
  return {
    title: detail ? `${detail.node.title} Node` : "Node",
    description: detail?.node.tagline ?? "Cogni node transparency view.",
  };
}

export default async function NodeDetailPage({
  params,
}: PageProps): Promise<ReactElement> {
  const { slug } = await params;
  const detail = await getNodeDetail(slug);
  if (!detail) notFound();
  return (
    <NodeDetailView
      node={detail.node}
      metrics={detail.metrics}
      topOwners={detail.topOwners}
    />
  );
}
