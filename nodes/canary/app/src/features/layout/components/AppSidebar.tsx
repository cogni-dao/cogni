// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/layout/components/AppSidebar`
 * Purpose: Canary-specific sidebar composition with nav items, collapsible chat threads, and lineage links.
 * Scope: Composes vendor Sidebar primitives into the app sidebar. Does not handle authentication or data fetching.
 * Invariants: Admin nav item is shown only when the session wallet is a repo-spec approver (`session.user.isApprover`).
 * Side-effects: reads NextAuth session (`useSession`)
 * Links: src/components/vendor/shadcn/sidebar.tsx, src/features/ai/chat/components/ChatThreadsSidebarGroup.tsx
 * @public
 */

"use client";

import {
  BookOpen,
  Briefcase,
  CreditCard,
  ExternalLink,
  Github,
  LayoutDashboard,
  Shield,
  Shell,
  Vote,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import type { ReactElement } from "react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
} from "@/components";
import { ChatThreadsSidebarGroup } from "@/features/ai/chat/components/ChatThreadsSidebarGroup";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/work", label: "Work", icon: Briefcase },
  { href: "/knowledge", label: "Knowledge", icon: BookOpen },
  { href: "/gov", label: "Gov", icon: Vote },
  { href: "/credits", label: "Credits", icon: CreditCard },
  { href: "/admin", label: "Admin", icon: Shield },
] as const;

const EXTERNAL_LINKS = [
  {
    href: "https://github.com/openclaw/openclaw",
    label: "OpenClaw",
    icon: Github,
  },
  {
    href: "https://clawhub.com",
    label: "ClawHub",
    icon: ExternalLink,
  },
] as const;

export function AppSidebar(): ReactElement {
  const pathname = usePathname();
  const { data: session } = useSession();
  const isApprover = session?.user?.isApprover ?? false;
  const navItems = NAV_ITEMS.filter(
    (item) => item.href !== "/admin" || isApprover
  );

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-16 shrink-0 justify-center">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="Cogni Canary">
              <Link href="/chat">
                <div className="flex aspect-square size-8 items-center justify-center text-primary">
                  <Shell className="size-5" />
                </div>
                <span className="truncate font-bold">
                  cogni<span className="text-primary">/canary</span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {navItems.map((item) => {
              const isActive =
                pathname === item.href ||
                pathname.startsWith(`${item.href.replace(/\/$/, "")}/`);
              return (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive}
                    tooltip={item.label}
                  >
                    <Link href={item.href}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}

            <ChatThreadsSidebarGroup />
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarSeparator />
        <SidebarMenu>
          {EXTERNAL_LINKS.map((item) => (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton asChild tooltip={item.label}>
                <a href={item.href} target="_blank" rel="noopener noreferrer">
                  <item.icon />
                  <span>{item.label}</span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
