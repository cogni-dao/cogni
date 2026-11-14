// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-app/extensions`
 * Purpose: Extension-point types for node customization — NavItem, ExternalLink, NodeAppConfig.
 * Scope: Pure type definitions. Does not contain runtime code, React components, or env access.
 * Invariants: All fields readonly; NodeAppConfig is the single customization surface for nodes.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-app-shell-contract
 * @public
 */

import type { ComponentType, ReactNode } from "react";

/** A primary navigation item rendered in the sidebar. */
export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
}

/** An external link rendered in the sidebar footer. */
export interface ExternalLink {
  readonly href: string;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
}

/** Node identity and customization surface. */
export interface NodeAppConfig {
  /** Display name shown in the sidebar header and metadata. */
  readonly name: string;

  /** Logo branding for the sidebar header. */
  readonly logo: {
    readonly src: string;
    readonly alt: string;
    readonly href: string;
  };

  /** Primary sidebar navigation items. */
  readonly navItems: readonly NavItem[];

  /** External links in sidebar footer (GitHub, Discord, etc.). */
  readonly externalLinks: readonly ExternalLink[];

  /** Extra sidebar content injected after nav items (e.g., ChatThreadsSidebarGroup). */
  readonly sidebarExtras?: ReactNode;
}
