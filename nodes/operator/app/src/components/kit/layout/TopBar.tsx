// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { cn } from "@cogni/node-ui-kit/util/cn";
import type { ComponentProps, ReactElement } from "react";
import { topBar } from "@/styles/ui";

/** Authenticated shell chrome; className is for layout. */
export function TopBar({
  className,
  ...props
}: ComponentProps<"header">): ReactElement {
  return <header className={cn(topBar(), className)} {...props} />;
}
