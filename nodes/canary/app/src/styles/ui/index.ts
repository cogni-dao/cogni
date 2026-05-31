// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@styles/ui`
 * Purpose: Barrel exports for split styling factories organized by domain.
 * Scope: Re-exports all CVA factories from domain-specific modules. Does not contain factory definitions.
 * Invariants: Explicit exports only (no export *); maintains backward compatibility; prevents circular dependencies.
 * Side-effects: none
 * Notes: Replaces monolithic ui.ts with domain-split architecture per AGENTS.md guidance.
 * Links: docs/spec/ui-implementation.md, src/styles/AGENTS.md
 * @public
 */

// Export variant types for external use
export type { VariantProps } from "class-variance-authority";
// Code components
export { codeToken, heroActionContainer, heroCodeBlock } from "./code";
// Data display components
export {
  amountButtons,
  avatar,
  avatarFallback,
  avatarImage,
  badge,
  card,
  cardContent,
  cardFooter,
  cardHeader,
  iconBox,
  ledgerEntry,
  ledgerHeader,
  ledgerList,
  ledgerMeta,
  statsBox,
  statsGrid,
} from "./data";
// Input components
export { button, input, modeToggle } from "./inputs";
// Layout components
export {
  container,
  flex,
  grid,
  header,
  heroButtons,
  heroText,
  heroVisual,
  pad,
  pageContainer,
  pageShell,
  row,
  section,
  twoColumn,
} from "./layout";

// Overlay components
export {
  chatContainer,
  chatDivider,
  chatForm,
  chatMessage,
  chatMessages,
  dropdownContent,
  dropdownMenuCheck,
  dropdownMenuItem,
  icon,
  iconButton,
  navLink,
  reveal,
  terminalBody,
  terminalDot,
  terminalFrame,
  terminalHeader,
  themeIcon,
} from "./overlays";
// Payment components
export {
  paymentFlowContainer,
  paymentFlowStatus,
  paymentFlowStep,
} from "./payments";
// Typography components
export {
  brandText,
  heading,
  paragraph,
  prompt,
  prose,
  textAccent,
} from "./typography";
