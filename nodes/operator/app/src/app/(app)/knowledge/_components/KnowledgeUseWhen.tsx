// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/KnowledgeUseWhen`
 * Purpose: Apply node-owned subtitle styling to the shared retrieval trigger.
 * Scope: Presentation; shared package owns rendering and empty-value semantics.
 * Side-effects: none
 * @internal
 */

import { KnowledgeUseWhen as SharedKnowledgeUseWhen } from "@cogni/knowledge-base-ui";

export function KnowledgeUseWhen({
  useWhen,
}: {
  readonly useWhen?: string | null | undefined;
}) {
  return (
    <SharedKnowledgeUseWhen
      useWhen={useWhen}
      className="text-muted-foreground text-sm leading-relaxed [&>span]:font-medium"
    />
  );
}
