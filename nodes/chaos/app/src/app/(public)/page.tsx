// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/page`
 * Purpose: Homepage with hero section and feature showcase. Redirects signed-in users to /chat.
 * Scope: Server component that checks session and redirects or renders landing page. Does not handle authentication logic — proxy.ts handles primary auth routing; server-side check here is defense-in-depth.
 * Invariants: Responsive design; uses Hero layout component.
 * Side-effects: IO (session check, redirect)
 * Links: src/components/kit/sections/Hero.tsx, src/features/home/components/*
 * @public
 */

import { redirect } from "next/navigation";
import type { ReactElement } from "react";

import { HomeStats } from "@/features/home/components/HomeStats";
import { NewHomeHero } from "@/features/home/components/NewHomeHero";
import { getServerSessionUser } from "@/lib/auth/server";

import { AuthRedirect } from "./AuthRedirect";

export default async function HomePage(): Promise<ReactElement> {
  const user = await getServerSessionUser();
  if (user) {
    redirect("/chat");
  }

  return (
    <div className="flex min-h-screen flex-col">
      <AuthRedirect />
      <NewHomeHero />
      <HomeStats />
    </div>
  );
}
