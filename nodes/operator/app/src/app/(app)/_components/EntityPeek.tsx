// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/_components/EntityPeek`
 * Purpose: Open a linked knowledge entry in a side sheet so the reader keeps their page.
 * Scope: One sheet per app shell. Links inside the sheet swap its entry. Work-item
 *   links, modified clicks (new tab, new window) and links outside a provider navigate.
 * Side-effects: IO (GET /api/v1/knowledge/:id through KnowledgeSelection)
 * @internal
 */

"use client";

import type { CitationLinkProps } from "@cogni/knowledge-base-ui";
import { isWorkItemEndpointId } from "@cogni/knowledge-store";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  createContext,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useContext,
  useState,
} from "react";

// The sheet loads only when a reader first peeks, so pages without links pay nothing.
const KnowledgeSelection = dynamic(
  () =>
    import("../knowledge/_components/KnowledgeSelection").then(
      (module) => module.KnowledgeSelection
    ),
  { ssr: false }
);

const PeekContext = createContext<((id: string) => void) | null>(null);

export function EntityPeekProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  const [id, setId] = useState<string | null>(null);
  return (
    <PeekContext.Provider value={setId}>
      {children}
      {id !== null && (
        <KnowledgeSelection id={id} onClose={() => setId(null)} />
      )}
    </PeekContext.Provider>
  );
}

/** A citation link that opens a knowledge entry in the side sheet; the href stays for new tabs. */
export function PeekLink({
  entityId,
  href,
  children,
  ...rest
}: CitationLinkProps): ReactElement {
  const open = useContext(PeekContext);
  const peekable =
    open !== null && !!entityId && !isWorkItemEndpointId(entityId);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!peekable || !entityId) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    if (event.button !== 0) return;
    event.preventDefault();
    open(entityId);
  };
  return (
    <Link href={href} onClick={onClick} {...rest}>
      {children}
    </Link>
  );
}
