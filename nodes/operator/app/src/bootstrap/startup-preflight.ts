// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { RuntimeSecretError } from "@/shared/env/invariants";
import { localReadinessPreflight } from "@/shared/env/local-readiness-preflight";
import { EnvValidationError } from "@/shared/env/server-env";

/** Permit diagnostic HTTP only for typed local configuration refusals. */
export function runStartupPreflight(): void {
  try {
    localReadinessPreflight();
  } catch (error) {
    if (
      !(
        error instanceof EnvValidationError ||
        error instanceof RuntimeSecretError
      )
    ) {
      throw error;
    }
    // Readiness repeats the same assertion and reports the configuration refusal.
  }
}
