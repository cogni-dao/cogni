// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/public/attribution/_lib/attribution-dto`
 * Purpose: Back-compat re-export. The DTO mappers now live in the feature layer
 *   (`@/features/attribution/read/attribution-dto`) so feature-layer readers (epoch-views) can
 *   import them without a features→app dependency. App routes keep this historical path.
 * @internal
 */

export * from "@/features/attribution/read/attribution-dto";
