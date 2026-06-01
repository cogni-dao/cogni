// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/KnowledgeDetail`
 * Purpose: Slide-over Sheet that renders a single knowledge entry's full content,
 *   with a copy-link affordance to the entry's permalink. Body shared with the
 *   routable `/knowledge/[id]` page via `KnowledgeEntryFields`.
 * Scope: Pure presentation; no fetching.
 * @internal
 */

"use client";

import type { KnowledgeRow } from "@cogni/node-contracts";
import type { ReactElement } from "react";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components";
import { CopyLinkButton } from "./CopyLinkButton";
import { KnowledgeEntryFields } from "./KnowledgeEntryFields";

interface KnowledgeDetailProps {
  readonly item: KnowledgeRow | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** When true, render the EDO chain walk inline below the entry body. */
  readonly showChain?: boolean;
}

export function KnowledgeDetail({
  item,
  open,
  onOpenChange,
  showChain = false,
}: KnowledgeDetailProps): ReactElement {
  const isHtml = item?.entryType === "html";
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className={
          isHtml
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
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-muted-foreground text-xs">
                  {item.id}
                </span>
                <CopyLinkButton
                  path={`/knowledge/${item.id}`}
                  label="Copy block link"
                />
              </div>
            </SheetHeader>

            <div className="mt-6">
              <KnowledgeEntryFields item={item} showChain={showChain} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
