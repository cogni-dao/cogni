// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/internship-subsidy/public`
 * Purpose: Public feature exports for intern subsidy prototype.
 * Scope: Re-exports services and UI components.
 * Invariants: no adapter exports.
 * Side-effects: none
 * Links: features/internship-subsidy/services/buildSubsidyPrototype.ts
 * @public
 */

export { InternshipSubsidyPrototype } from "./components/InternshipSubsidyPrototype";
export {
  type BuildSubsidyPrototypeDeps,
  type BuildSubsidyPrototypeInput,
  buildSubsidyPrototype,
} from "./services/buildSubsidyPrototype";
