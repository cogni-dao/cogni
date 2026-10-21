// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/KnowledgeEntryFields`
 * Purpose: The body of a single knowledge entry — confidence, content, source, tags,
 *   created, and paged direct relation summaries. Shared by the slide-over
 *   `KnowledgeDetail` (list context) and the routable `/knowledge/[id]` page.
 * Scope: Entry presentation plus bounded direct relations; no chain traversal.
 * @internal
 */

"use client";

import type { KnowledgeRow } from "@cogni/node-contracts";
import type { ReactElement } from "react";

import { Markdown } from "@/components";
import { EntityCitationLinks } from "../../_components/EntityCitationLinks";
import { ConfidenceBar } from "./ConfidenceBar";
import { HtmlRenderer } from "./HtmlRenderer";
import { RelativeTime } from "./RelativeTime";

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): ReactElement | null {
  if (!children) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
        {label}
      </span>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export function KnowledgeEntryFields({
  item,
}: {
  readonly item: KnowledgeRow;
}): ReactElement {
  const isHtml = item.entryType === "html";
  return (
    <div className="flex flex-col gap-5 px-1">
      <Field label="Confidence">
        <ConfidenceBar value={item.confidencePct} width={120} />
      </Field>

      <Field label="Content">
        {isHtml ? (
          <HtmlRenderer html={item.content} title={item.title} />
        ) : (
          <Markdown content={item.content} className="leading-relaxed" />
        )}
      </Field>

      <Field label="Source">
        <div className="flex flex-col gap-1 font-mono text-xs">
          <span>{item.sourceType}</span>
          {item.sourceRef && (
            <span className="text-muted-foreground">{item.sourceRef}</span>
          )}
        </div>
      </Field>

      <EntityCitationLinks entityId={item.id} />

      {item.tags && item.tags.length > 0 && (
        <Field label="Tags">
          <div className="flex flex-wrap gap-1.5">
            {item.tags.map((t) => (
              <span
                key={t}
                className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs"
              >
                {t}
              </span>
            ))}
          </div>
        </Field>
      )}

      {item.createdAt && (
        <Field label="Created">
          <RelativeTime iso={item.createdAt} />
        </Field>
      )}
    </div>
  );
}
