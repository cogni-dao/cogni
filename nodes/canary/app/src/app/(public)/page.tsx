// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { redirect } from "next/navigation";
import type { ReactElement } from "react";

import { CanaryHomeCta } from "@/features/home/components/CanaryHomeCta";
import { CanaryHomeHero } from "@/features/home/components/CanaryHomeHero";
import { CanaryHomeSignals } from "@/features/home/components/CanaryHomeSignals";
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
      <CanaryHomeHero />
      <CanaryHomeSignals />
      <CanaryHomeCta />
    </div>
  );
}
