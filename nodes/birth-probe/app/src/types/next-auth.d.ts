// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user?: {
      id: string;
      walletAddress?: string | null;
      displayName?: string | null;
      avatarColor?: string | null;
      /** Derived in the session callback: wallet ∈ repo-spec approver allowlist. UX hint only. */
      isApprover?: boolean;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }

  interface User {
    walletAddress?: string | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    walletAddress?: string | null;
    displayName?: string | null;
    avatarColor?: string | null;
  }
}
