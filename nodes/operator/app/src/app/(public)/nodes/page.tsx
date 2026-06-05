// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/nodes/page`
 * Purpose: Public operator-owned node gallery with attribution and activity metrics.
 * Scope: Server component. Reads via app facade and renders feature components.
 * Side-effects: IO (registry and metric reads through facade)
 * Links: task.5006, src/app/_facades/nodes/gallery.server.ts
 * @public
 */

import type { Metadata } from "next";
import type { ReactElement } from "react";

import { listNodeGallery } from "@/app/_facades/nodes/gallery.server";
import { NodeRegistrationForm } from "@/features/nodes/components/NodeRegistrationForm.client";
import { NodesGallery } from "@/features/nodes/components/NodesGallery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Cogni Nodes",
  description:
    "Public activity, attribution, and ownership views for Cogni nodes.",
};

export default async function NodesPage(): Promise<ReactElement> {
  const items = await listNodeGallery();
  return (
    <NodesGallery items={items} registrationForm={<NodeRegistrationForm />} />
  );
}
