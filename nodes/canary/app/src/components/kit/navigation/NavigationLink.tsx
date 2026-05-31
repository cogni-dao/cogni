// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/navigation/NavigationLink`
 * Purpose: Navigation link with active route detection and current page semantics.
 * Scope: Provides Link wrapper with pathname normalization and match modes. Does not handle external URLs or routing.
 * Invariants: Normalizes paths; supports exact/prefix matching; sets active state via CVA factory.
 * Side-effects: global
 * Notes: Client component for usePathname; handles basePath and locale prefixes; never for external URLs.
 * Links: docs/spec/ui-implementation.md, Next.js usePathname
 * @public
 */

"use client";

import { cn } from "@cogni/node-ui-kit/util/cn";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import type { VariantProps } from "@/styles/ui";
import { navLink } from "@/styles/ui";

type MatchMode = "exact" | "prefix";

type NextLinkProps = ComponentPropsWithoutRef<typeof Link>;

interface NavigationLinkProps
  extends VariantProps<typeof navLink>,
    Omit<NextLinkProps, "href" | "className"> {
  readonly href: string;
  readonly children: ReactNode;
  readonly match?: MatchMode;
  readonly localePrefix?: string;
  readonly basePath?: string;
  /**
   * Optional className for layout adjustments only (flex/gap/margin). Colors/typography remain CVA-controlled.
   */
  readonly className?: string;
}

function norm(path: string): string {
  const parts = path.split(/[?#]/);
  const u = parts[0] ?? "";
  return u !== "/" ? u.replace(/\/+$/, "") : "/";
}

function stripPrefix(path: string, prefix?: string): string {
  if (!prefix) return path;
  return path.startsWith(prefix) ? path.slice(prefix.length) || "/" : path;
}

export function NavigationLink({
  href,
  children,
  size = "sm",
  match = "exact",
  localePrefix,
  basePath,
  className,
  ...linkProps
}: NavigationLinkProps): ReactElement {
  const pathname = usePathname() || "/";
  // Normalize current and target
  const current = norm(
    stripPrefix(stripPrefix(pathname, basePath), localePrefix)
  );
  const target = norm(stripPrefix(stripPrefix(href, basePath), localePrefix));

  const isActive =
    match === "exact"
      ? current === target
      : current === target || current.startsWith(`${target}/`);

  return (
    <Link
      href={href}
      className={cn(
        navLink({ size, state: isActive ? "active" : "default" }),
        className
      )}
      {...linkProps}
      aria-current={isActive ? "page" : undefined}
    >
      {children}
    </Link>
  );
}
