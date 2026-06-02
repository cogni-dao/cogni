// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/layout/components/AppSidebar`
 * Purpose: Cogni-specific sidebar composition with nav items, collapsible chat threads, and external links.
 * Scope: Composes vendor Sidebar primitives into the app sidebar. Does not handle authentication or data fetching.
 * Invariants: Admin nav item is shown only when the session wallet is a repo-spec approver (`session.user.isApprover`); the `(admin)/` layout still enforces server-side. Chat threads always visible as collapsible menu item.
 * Side-effects: reads NextAuth session (`useSession`)
 * Links: src/components/vendor/shadcn/sidebar.tsx, src/features/ai/chat/components/ChatThreadsSidebarGroup.tsx
 * @public
 */

"use client";

import {
  BookOpen,
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
    href: "https://github.com/cogni-DAO/cogni-template",
    label: "GitHub",
    icon: Github,
  },
  {
    href: "https://discord.gg/3b9sSyhZ4z",
    label: "Discord",
    icon: DiscordIcon,
  },
] as const;

function DiscordIcon({ className }: { className?: string }): ReactElement {
  return (
    <svg
      viewBox="0 0 127.14 96.36"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z" />
    </svg>
  );
}

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
