// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/** The item sheet: this node's binding of `WorkItemView` (story.0085, ONE_VIEW). No section or field lives here. */
"use client";
import type { CitationLinkComponent } from "@cogni/knowledge-base-ui";
import { WorkItemView } from "@cogni/knowledge-base-ui/work-item";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { ComponentProps, ReactElement } from "react";
import {
  Markdown,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components";
import { PeekLink } from "../../_components/EntityPeek";
import { workItemClient } from "../_api/fetchWorkItems";
import { workItemHref } from "../_lib/workItemNavigation";

const ScrollKeepingLink: CitationLinkComponent = ({
  entityId: _entityId,
  href,
  ...p
}) => <Link href={href} scroll={false} {...p} />;
type Body = Pick<
  ComponentProps<typeof WorkItemView>,
  "item" | "itemId" | "isLoading" | "error"
>;

export function WorkItemDetail({
  open,
  onOpenChange,
  ...body
}: Body & {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  const searchParams = useSearchParams() ?? undefined;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <WorkItemView
          {...body}
          client={workItemClient}
          {...(searchParams && { searchParams })}
          itemHref={workItemHref}
          Link={ScrollKeepingLink}
          PeekLink={PeekLink}
          Markdown={Markdown}
          Header={SheetHeader}
          Title={SheetTitle}
          Description={SheetDescription}
        />
      </SheetContent>
    </Sheet>
  );
}
