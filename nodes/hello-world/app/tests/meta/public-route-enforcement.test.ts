// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/meta/public-route-enforcement`
 * Purpose: CI enforcement for public API namespace policy.
 * Scope: Scans /api/v1/public/** route files; ensures wrapPublicRoute() usage; forbids sensitive imports. Does NOT test runtime behavior.
 * Invariants: All public routes use wrapPublicRoute(); no db/session/billing imports; CI fails if violations found.
 * Side-effects: IO (file system reads)
 * Notes: Runs in CI as part of pnpm check; prevents unsafe public routes from merging.
 * Links: src/bootstrap/http/wrapPublicRoute.ts, src/proxy.ts
 * @public
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP_ROOT = process.cwd();
const PUBLIC_API_DIR = join(APP_ROOT, "src/app/api/v1/public");
const CONTRACT_TEST_DIR = join(APP_ROOT, "tests/contract/app");
const STACK_TEST_DIR = join(APP_ROOT, "tests/stack/public");

/**
 * Recursively find all route.ts files under a directory.
 */
function findRouteFiles(dir: string): string[] {
  const routes: string[] = [];

  function walk(currentDir: string): void {
    const entries = readdirSync(currentDir);

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (entry === "route.ts") {
        routes.push(fullPath);
      }
    }
  }

  walk(dir);
  return routes;
}

describe("Public API Namespace Enforcement", () => {
  const publicRoutes = findRouteFiles(PUBLIC_API_DIR);

  it("should have at least one public route (sanity check)", () => {
    expect(publicRoutes.length).toBeGreaterThan(0);
  });

  it("ALL /api/v1/public/** routes MUST use wrapPublicRoute()", () => {
    const violations: string[] = [];

    for (const routePath of publicRoutes) {
      const content = readFileSync(routePath, "utf-8");

      // Check for wrapPublicRoute usage
      const usesWrapPublicRoute = content.includes("wrapPublicRoute");

      // Check for prohibited wrappers
      const usesWrapRouteHandlerWithLogging = content.includes(
        "wrapRouteHandlerWithLogging"
      );

      if (!usesWrapPublicRoute) {
        violations.push(
          `${routePath}: Missing wrapPublicRoute() - all public routes MUST use this wrapper`
        );
      }

      if (usesWrapRouteHandlerWithLogging) {
        violations.push(
          `${routePath}: Uses wrapRouteHandlerWithLogging instead of wrapPublicRoute()`
        );
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Public route violations found:\n${violations.join("\n")}`
      );
    }
  });

  it("ALL /api/v1/public/** routes MUST NOT import sensitive modules", () => {
    const violations: string[] = [];

    // Forbidden imports (expand as needed)
    const forbiddenImports = [
      "@/shared/db",
      "@/adapters/server/db",
      "drizzle-orm",
      "@/lib/auth/mapping", // Billing account mapping
      "@/features/payments", // Payment services
      "getSessionUser", // Session utilities (public routes have no session)
      "@/ports/accounts", // Account service port
    ];

    for (const routePath of publicRoutes) {
      const content = readFileSync(routePath, "utf-8");

      for (const forbidden of forbiddenImports) {
        if (content.includes(forbidden)) {
          violations.push(
            `${routePath}: Forbidden import '${forbidden}' - public routes must not access sensitive data`
          );
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Sensitive imports in public routes:\n${violations.join("\n")}`
      );
    }
  });

  it("ALL /api/v1/public/** routes MUST have corresponding tests", () => {
    const violations: string[] = [];

    for (const routePath of publicRoutes) {
      // Extract route name from path (e.g., "analytics/summary")
      const routeName = routePath
        .replace(`${PUBLIC_API_DIR}/`, "")
        .replace("/route.ts", "");

      // Check for contract test
      const contractTestPath = join(
        CONTRACT_TEST_DIR,
        `${routeName.replace(/\//g, ".")}.test.ts`
      );
      const contractTestExists = existsSync(contractTestPath);

      // Check for stack test (optional but recommended)
      const stackTestPath = join(
        STACK_TEST_DIR,
        `${routeName.split("/").pop()}.stack.test.ts`
      );
      const stackTestExists = existsSync(stackTestPath);

      if (!contractTestExists && !stackTestExists) {
        violations.push(
          `${routePath}: No tests found (expected ${contractTestPath} or ${stackTestPath})`
        );
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Missing tests for public routes:\n${violations.join("\n")}`
      );
    }
  });
});
