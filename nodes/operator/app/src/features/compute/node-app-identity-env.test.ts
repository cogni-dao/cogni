// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { buildNodeAppIdentityEnv } from "./node-app-identity-env";

describe("buildNodeAppIdentityEnv", () => {
  const BASE = {
    slug: "levelup",
    publicUrl: "https://levelup.cognidao.org",
    env: {
      DATABASE_URL: "postgres://scoped@vm/levelup",
      AUTH_SECRET: "s3cr3t",
    },
  };

  it("preserves the caller's connection env", () => {
    const env = buildNodeAppIdentityEnv(BASE);
    expect(env.DATABASE_URL).toBe("postgres://scoped@vm/levelup");
    expect(env.AUTH_SECRET).toBe("s3cr3t");
  });

  it("stamps the canonical identity config", () => {
    expect(buildNodeAppIdentityEnv(BASE)).toMatchObject({
      NODE_NAME: "levelup",
      COGNI_REPO_PATH: "/app",
      AUTH_TRUST_HOST: "true",
      NEXTAUTH_URL: "https://levelup.cognidao.org",
      APP_BASE_URL: "https://levelup.cognidao.org",
    });
  });

  it("CANONICAL_IDENTITY_WINS: a stale caller value cannot redirect the app", () => {
    const env = buildNodeAppIdentityEnv({
      ...BASE,
      env: { ...BASE.env, NEXTAUTH_URL: "https://stale.example.com" },
    });
    expect(env.NEXTAUTH_URL).toBe("https://levelup.cognidao.org");
  });
});
