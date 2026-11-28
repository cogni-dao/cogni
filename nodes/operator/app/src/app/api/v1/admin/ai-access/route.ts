// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { adminRoute } from "./admin-route";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = adminRoute("list");
export const POST = adminRoute("on");
export const DELETE = adminRoute("off");
