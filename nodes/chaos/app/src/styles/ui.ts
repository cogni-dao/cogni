// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@styles/ui`
 * Purpose: Centralized styling API using CVA factories for design token enforcement and type-safe variants.
 * Scope: Provides all component styling via typed factories. Does not handle CSS-in-JS or runtime theme switching.
 * Invariants: All variants use design tokens; factories return valid Tailwind class strings; TypeScript enforces variant types.
 * Side-effects: none
 * Notes: Migrated to domain-split architecture - factories now in ui/* modules with explicit barrel exports.
 * Links: docs/spec/ui-implementation.md, src/styles/ui/index.ts
 * @public
 */

// Export specific variant types for backward compatibility
export type { BadgeIntent } from "./ui/data";
// Re-export all CVA factories from domain-split modules
export * from "./ui/index";
export type { ButtonSize } from "./ui/inputs";
export type { ContainerSize } from "./ui/layout";
export type { HeadingLevel } from "./ui/typography";

// Note: Individual variant types are now defined in their respective domain modules
