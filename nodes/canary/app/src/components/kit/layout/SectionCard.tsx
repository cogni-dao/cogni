// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/layout/SectionCard`
 * Purpose: Card with distinct header and content regions for form sections.
 * Scope: Wraps shadcn Card with fixed padding and spacing. Does not handle form submission.
 * Invariants: Header has border-b separator; content area stacks children with space-y-6; padding is fixed at px-6 py-6.
 * Side-effects: none
 * Notes: Mobile-first pattern - padding and font sizes work on small screens
 * Links: Built on shadcn Card primitive
 * @public
 */

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@cogni/node-ui-kit/shadcn/card";
import { cn } from "@cogni/node-ui-kit/util/cn";

interface SectionCardProps {
  title: string;
  children: React.ReactNode;
  className?: string;
}

export function SectionCard({ title, children, className }: SectionCardProps) {
  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader className="border-border border-b px-6 py-4">
        <CardTitle className="font-bold text-xl">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6 px-6 py-6">{children}</CardContent>
    </Card>
  );
}
