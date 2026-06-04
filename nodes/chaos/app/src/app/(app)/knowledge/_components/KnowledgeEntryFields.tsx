// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/KnowledgeEntryFields`
 * Purpose: The body of a single knowledge entry — confidence, content, source, tags,
 *   created, and (optionally) the EDO chain walk. Shared by the slide-over
 *   `KnowledgeDetail` (list context) and the routable `/knowledge/[id]` page.
 * Scope: Pure presentation; no fetching.
 * @internal
 */

"use client";

import type { KnowledgeRow } from "@cogni/node-contracts";
import type { ReactElement } from "react";

import { ChainPanel } from "./ChainPanel";
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
  showChain = false,
}: {
  readonly item: KnowledgeRow;
  /** When true, render the EDO chain walk inline below the entry body. */
  readonly showChain?: boolean;
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
          <p className="whitespace-pre-wrap leading-relaxed">{item.content}</p>
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

      {showChain && (
        <div className="mt-2 border-border/60 border-t pt-4">
          <ChainPanel rootId={item.id} />
        </div>
      )}
    </div>
  );
}
