// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/layout/components/footer-items`
 * Purpose: Footer column, link, social icon data, and brand SVG icons for AppFooter.
 * Scope: Static data and brand icon components. Does not render page-level UI.
 * Invariants: All external links have external: true.
 * Side-effects: none
 * Links: src/features/layout/components/AppFooter.tsx
 * @public
 */

import type { ComponentType } from "react";

import { DiscordIcon, GitHubIcon } from "@/components";

export interface FooterLink {
  label: string;
  href: string;
  external?: boolean;
}

export interface FooterColumn {
  title: string;
  links: FooterLink[];
}

export interface SocialLink {
  label: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
}

export const FOOTER_COLUMNS: FooterColumn[] = [
  {
    title: "Platform",
    links: [
      { label: "Chat", href: "/chat" },
      { label: "Work", href: "/work" },
      { label: "Knowledge", href: "/knowledge" },
      { label: "Activity", href: "/activity" },
      { label: "Governance", href: "/gov" },
      { label: "Credits", href: "/credits" },
    ],
  },
  {
    title: "About",
    links: [
      {
        label: "Documentation",
        href: "https://github.com/cogni-DAO/cogni-template",
        external: true,
      },
    ],
  },
  {
    title: "Community",
    links: [
      {
        label: "GitHub",
        href: "https://github.com/cogni-DAO/cogni-template",
        external: true,
      },
      {
        label: "Discord",
        href: "https://discord.gg/3b9sSyhZ4z",
        external: true,
      },
    ],
  },
];

export const SOCIAL_LINKS: SocialLink[] = [
  {
    label: "GitHub",
    href: "https://github.com/cogni-DAO/cogni-template",
    icon: GitHubIcon,
  },
  {
    label: "Discord",
    href: "https://discord.gg/3b9sSyhZ4z",
    icon: DiscordIcon,
  },
];
