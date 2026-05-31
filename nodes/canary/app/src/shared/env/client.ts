// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/env/client`
 * Purpose: Client-side environment variable validation for Next.js public env vars using Zod schema.
 * Scope: Validates NEXT_PUBLIC_* env vars for browser runtime; provides lazy clientEnv access. Does not handle server-only vars.
 * Invariants: Only processes NEXT_PUBLIC_ prefixed vars; validates on first access; fails fast on missing required vars.
 * Side-effects: process.env
 * Notes: WalletConnect project ID optional (degrades to injected wallet only); lazy initialization prevents build-time access.
 * Links: Next.js public environment variables specification
 * @public
 */

import { ZodError, z } from "zod";

export interface ClientEnvValidationMeta {
  code: "INVALID_CLIENT_ENV";
  missing: string[];
  invalid: string[];
}

export class ClientEnvValidationError extends Error {
  readonly meta: ClientEnvValidationMeta;

  constructor(meta: ClientEnvValidationMeta) {
    super(`Invalid client env: ${JSON.stringify(meta)}`);
    this.name = "ClientEnvValidationError";
    this.meta = meta;
  }
}

const clientSchema = z.object({
  // Optional - gracefully degrades to injected wallet only if missing
  NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: z.string().min(1).optional(),
});

type ClientEnv = z.infer<typeof clientSchema>;

let _clientEnv: ClientEnv | null = null;

export function clientEnv(): ClientEnv {
  if (_clientEnv === null) {
    try {
      _clientEnv = clientSchema.parse({
        NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID:
          process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        const missing = new Set<string>();
        const invalid = new Set<string>();

        for (const issue of error.issues) {
          const key = issue.path[0]?.toString();
          if (!key) continue;

          /*
           * Treat all invalid_type as missing (avoids any casting)
           */
          if (issue.code === "invalid_type") {
            missing.add(key);
          } else {
            invalid.add(key);
          }
        }

        const meta: ClientEnvValidationMeta = {
          code: "INVALID_CLIENT_ENV",
          missing: [...missing],
          invalid: [...invalid],
        };

        throw new ClientEnvValidationError(meta);
      }

      throw error;
    }
  }
  return _clientEnv;
}

export type { ClientEnv };
