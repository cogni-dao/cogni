// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/layout/components/AppSidebar`
 * Purpose: Cogni-specific sidebar composition with nav items, collapsible chat threads, and external links.
 * Scope: Composes vendor Sidebar primitives into the app sidebar. Does not handle authentication or data fetching.
 * Invariants: Nav items are static; chat threads always visible as collapsible menu item.
 * Side-effects: none
 * Links: src/components/vendor/shadcn/sidebar.tsx, src/features/ai/chat/components/ChatThreadsSidebarGroup.tsx
 * @public
 */

"use client";

import {
  BookOpen,
  Boxes,
  Briefcase,
  CreditCard,
  Github,
  LayoutDashboard,
  Shield,
  Vote,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
  { href: "/nodes", label: "Nodes", icon: Boxes },
  { href: "/gov", label: "Gov", icon: Vote },
  { href: "/credits", label: "Credits", icon: CreditCard },
  // Admin tab — server-gated by (admin)/layout.tsx (isDaoAdmin); non-admins redirect to /dashboard.
  { href: "/admin", label: "Admin", icon: Shield },
] as const;

const EXTERNAL_LINKS = [
  {
    href: "https://github.com/cogni-dao",
    label: "GitHub",
    icon: Github,
  },
] as const;

export function AppSidebar(): ReactElement {
  const pathname = usePathname();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-16 shrink-0 justify-center">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="Cogni">
              <Link href="/chat">
                <div className="flex aspect-square size-8 items-center justify-center">
                  <Image
                    src="/TransparentBrainOnly.png"
                    alt="Cogni"
                    width={24}
                    height={24}
                  />
                </div>
                <span className="truncate font-bold text-gradient-accent">
                  Cogni
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {NAV_ITEMS.map((item) => {
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

            {/* Collapsible Threads — last item so it can expand downward */}
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
