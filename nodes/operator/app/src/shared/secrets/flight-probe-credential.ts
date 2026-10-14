// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Canonical flight-prober credential contract shared by the OpenBao adapter
 * and the projection route. Exactly 32 random bytes encoded as padded RFC 4648
 * Base64 keeps quotes, backslashes, and control bytes out of downstream
 * curl-config construction.
 */

import { z } from "zod";

export const flightProbeCredentialSchema = z
  .string()
  .length(44)
  .regex(/^[A-Za-z0-9+/]{43}=$/);

export const flightProbeRingSchema = z
  .object({
    active: flightProbeCredentialSchema,
    previous: flightProbeCredentialSchema.nullable(),
  })
  .strict()
  .refine((ring) => ring.previous === null || ring.previous !== ring.active);

export type FlightProbeRing = z.infer<typeof flightProbeRingSchema>;
