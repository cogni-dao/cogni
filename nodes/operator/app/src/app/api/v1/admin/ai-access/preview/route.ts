// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Preview never decides an access request. */
import { adminRoute } from "../admin-route";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = adminRoute("preview");
