// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/KnowledgeDetail`
 * Purpose: Slide-over Sheet that renders a single knowledge entry's full content.
 * Scope: Pure presentation; no fetching.
 * @internal
 */

"use client";

import type { KnowledgeRow } from "@cogni/node-contracts";
import type { ReactElement } from "react";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components";
import { ConfidenceBar } from "./ConfidenceBar";
import { DesignVisualRenderer } from "./DesignVisualRenderer";

interface KnowledgeDetailProps {
  readonly item: KnowledgeRow | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

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

export function KnowledgeDetail({
  item,
  open,
  onOpenChange,
}: KnowledgeDetailProps): ReactElement {
  const isDesignVisual = item?.entryType === "design-visual";
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className={
          isDesignVisual
            ? "w-full overflow-y-auto sm:max-w-4xl"
            : "w-full overflow-y-auto sm:max-w-lg"
        }
      >
        {item && (
          <>
            <SheetHeader>
              <span className="font-mono text-muted-foreground text-xs">
                {item.domain}
                {item.entityId ? ` · ${item.entityId}` : ""}
              </span>
              <SheetTitle className="text-lg leading-snug">
                {item.title}
              </SheetTitle>
              <span className="font-mono text-muted-foreground text-xs">
                {item.id}
              </span>
            </SheetHeader>

            <div className="mt-6 flex flex-col gap-5 px-1">
              <Field label="Confidence">
                <ConfidenceBar value={item.confidencePct} width={120} />
              </Field>

              <Field label="Content">
                {isDesignVisual ? (
                  <DesignVisualRenderer
                    content={item.content}
                    title={item.title}
                  />
                ) : (
                  <p className="whitespace-pre-wrap leading-relaxed">
                    {item.content}
                  </p>
                )}
              </Field>

              <Field label="Source">
                <div className="flex flex-col gap-1 font-mono text-xs">
                  <span>{item.sourceType}</span>
                  {item.sourceRef && (
                    <span className="text-muted-foreground">
                      {item.sourceRef}
                    </span>
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
                  <span className="font-mono text-muted-foreground text-xs">
                    {item.createdAt}
                  </span>
                </Field>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
