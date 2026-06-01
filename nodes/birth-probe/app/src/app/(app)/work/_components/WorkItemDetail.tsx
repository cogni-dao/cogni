// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

"use client";

import type { WorkItemDto } from "@cogni/node-contracts";
import type { ReactElement } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components";

import { StatusPill, TypeIcon } from "./work-item-icons";

type SubjectRef = WorkItemDto["assignees"][number];

function assigneeLabel(a: SubjectRef): string {
  switch (a.kind) {
    case "user":
      return a.userId;
    case "agent":
      return a.agentId;
    case "system":
      return a.serviceId;
  }
}

interface WorkItemDetailProps {
  readonly item: WorkItemDto | null;
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

export function WorkItemDetail({
  item,
  open,
  onOpenChange,
}: WorkItemDetailProps): ReactElement {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {item && (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                <TypeIcon type={item.type} className="size-5" />
                <span className="font-mono text-muted-foreground text-sm">
                  {item.id}
                </span>
              </div>
              <SheetTitle className="text-lg leading-snug">
                {item.title}
              </SheetTitle>
            </SheetHeader>

            <div className="mt-6 flex flex-col gap-5 px-1">
              {/* Status + Priority row */}
              <div className="flex flex-wrap items-center gap-3">
                <StatusPill status={item.status} />
                {item.priority != null && (
                  <span className="inline-flex rounded-md bg-muted px-2 py-0.5 font-medium text-xs">
                    P{item.priority}
                  </span>
                )}
                {item.estimate != null && (
                  <span className="text-muted-foreground text-xs">
                    Est: {item.estimate}
                  </span>
                )}
              </div>

              {/* Summary */}
              {item.summary && <Field label="Summary">{item.summary}</Field>}

              {/* Outcome */}
              {item.outcome && <Field label="Outcome">{item.outcome}</Field>}

              {/* Project */}
              {item.projectId && (
                <Field label="Project">{item.projectId}</Field>
              )}

              {/* Branch / PR */}
              {(item.branch || item.pr) && (
                <div className="flex gap-6">
                  {item.branch && (
                    <Field label="Branch">
                      <code className="text-xs">{item.branch}</code>
                    </Field>
                  )}
                  {item.pr && (
                    <Field label="PR">
                      <code className="text-xs">{item.pr}</code>
                    </Field>
                  )}
                </div>
              )}

              {/* Blocked by */}
              {item.blockedBy && (
                <Field label="Blocked By">
                  <span className="font-mono text-destructive text-xs">
                    {item.blockedBy}
                  </span>
                </Field>
              )}

              {/* Labels */}
              {item.labels.length > 0 && (
                <Field label="Labels">
                  <div className="flex flex-wrap gap-1.5">
                    {item.labels.map((l) => (
                      <span
                        key={l}
                        className="rounded-md bg-muted px-2 py-0.5 text-xs"
                      >
                        {l}
                      </span>
                    ))}
                  </div>
                </Field>
              )}

              {/* Spec refs */}
              {item.specRefs.length > 0 && (
                <Field label="Spec Refs">
                  <div className="flex flex-col gap-1">
                    {item.specRefs.map((s) => (
                      <code key={s} className="text-xs">
                        {s}
                      </code>
                    ))}
                  </div>
                </Field>
              )}

              {/* Assignees */}
              {item.assignees.length > 0 && (
                <Field label="Assignees">
                  <div className="flex flex-wrap gap-2">
                    {item.assignees.map((a, i) => (
                      <span
                        key={`${a.kind}-${i}`}
                        className="rounded-md bg-muted px-2 py-0.5 text-xs"
                      >
                        {assigneeLabel(a)}
                      </span>
                    ))}
                  </div>
                </Field>
              )}

              {/* Timestamps */}
              <div className="flex gap-6 border-t pt-4 text-muted-foreground text-xs">
                <span>Created: {item.createdAt.slice(0, 10)}</span>
                <span>Updated: {item.updatedAt.slice(0, 10)}</span>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
