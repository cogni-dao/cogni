// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

"use client";

import {
  SidebarMenuButton as BaseSidebarMenuButton,
  SidebarMenuSubButton as BaseSidebarMenuSubButton,
} from "@cogni/node-ui-kit/shadcn/sidebar";
import { cn } from "@cogni/node-ui-kit/util/cn";
import type { ComponentProps } from "react";

/** Operator-specific active treatment for the baseline sidebar primitives. */
export function SidebarMenuButton({
  className,
  ...props
}: ComponentProps<typeof BaseSidebarMenuButton>) {
  return (
    <BaseSidebarMenuButton
      {...props}
      className={cn("data-[active=true]:bg-sidebar-accent", className)}
    />
  );
}

export function SidebarMenuSubButton({
  className,
  ...props
}: ComponentProps<typeof BaseSidebarMenuSubButton>) {
  return (
    <BaseSidebarMenuSubButton
      {...props}
      className={cn("data-[active=true]:bg-sidebar-accent", className)}
    />
  );
}
