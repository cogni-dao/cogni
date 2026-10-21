// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/KnowledgeUseWhen`
 * Purpose: Shared retrieval-trigger subtitle for atom readers and inbox previews.
 * Scope: Pure presentation; hides absent or blank triggers.
 * Side-effects: none
 * @internal
 */

export function KnowledgeUseWhen({
  useWhen,
}: {
  readonly useWhen?: string | null | undefined;
}) {
  const trigger = useWhen?.trim();
  if (!trigger) return null;

  return (
    <p className="text-muted-foreground text-sm leading-relaxed">
      <span className="font-medium">Use when:</span> {trigger}
    </p>
  );
}
