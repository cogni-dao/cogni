// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@/auth`
 * Purpose: NextAuth.js configuration and export.
 * Scope: App-wide authentication configuration. Does not handle client-side session management.
 * Invariants: SIWE + OAuth resolve to canonical user_id via user_bindings ; NO_AUTO_MERGE enforced on link-intent conflicts ; atomic new-user tx (user + binding + event) ; GITHUB_ISSUER_PINNED — the GitHub provider must declare the RFC 9207 issuer or openid-client rejects every callback
 * Side-effects: IO
 * Notes: Handles session creation, validation, and persistence.
 * Links: https://node-template.cognidao.org/knowledge/authentication-session-bearer
 * @public
 */

/* eslint-disable boundaries/no-unknown-files */

import nodeCrypto, { randomUUID } from "node:crypto";
import {
  AnalyticsEvents,
  capture,
  isFailedIntent,
  isPendingIntent,
  linkIntentStore,
} from "@cogni/node-shared";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { NextAuthOptions } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Discord from "next-auth/providers/discord";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import { getCsrfToken } from "next-auth/react";
import { SiweMessage } from "siwe";
import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import { createBinding } from "@/adapters/server/identity/create-binding";
import {
  identityEvents,
  linkTransactions,
  userBindings,
  userProfiles,
  users,
} from "@/shared/db/schema";
import { signedInSessionStore } from "@/shared/identity/signed-in-session-store";
import { makeLogger } from "@/shared/observability";

export const authSecret =
  process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "";

// Lazy logger initialization to avoid module-level env validation
const getLog = () => makeLogger({ module: "auth" });

const LINK_INTENT_TTL = 5 * 60; // 5 minutes — must match route.ts

/**
 * RFC 9207 issuer identifier GitHub returns as `iss` on the OAuth redirect.
 *
 * GitHub enabled Authorization Server Issuer Identification in April 2026, so every
 * authorization response now carries `iss=https://github.com/login/oauth`. openid-client
 * reacts to the parameter's mere presence — `if ('iss' in params) assertIssuerConfiguration(
 * this.issuer, 'issuer')` — and next-auth's GitHub provider declares no `issuer`, so
 * `new Issuer({ issuer: undefined, ... })` made that assert throw
 * `TypeError: issuer must be configured on the issuer`. next-auth wrapped it as
 * `OAuthCallbackError` and bounced the browser to `/?error=OAuthCallback`: from April 2026
 * until this constant landed, EVERY GitHub sign-in on EVERY env failed (bug.5071).
 *
 * The value must byte-match what GitHub sends; a wrong one fails loudly and specifically
 * (`iss mismatch, expected X, got: Y`) rather than silently. Google needs no equivalent —
 * its provider discovers `wellKnown`, which populates `issuer` already.
 */
const GITHUB_OAUTH_ISSUER = "https://github.com/login/oauth";

/**
 * Create a link transaction row in the DB. Called by the link initiation route
 * to establish DB-backed authority for the linking flow.
 * Returns the transaction ID for inclusion in the JWT cookie.
 */
export async function createLinkTransaction(
  userId: string,
  provider: string
): Promise<string> {
  const db = getServiceDb();
  const txId = randomUUID();
  const expiresAt = new Date(Date.now() + LINK_INTENT_TTL * 1000);
  await db.insert(linkTransactions).values({
    id: txId,
    userId,
    provider,
    expiresAt,
  });
  return txId;
}

/**
 * Atomically consume a link transaction. Returns the userId if the transaction
 * is valid (exists, not consumed, not expired, matches provider), or null if not.
 * Single UPDATE with all conditions — no separate SELECT needed.
 */
async function consumeLinkTransaction(
  txId: string,
  userId: string,
  provider: string
): Promise<string | null> {
  const db = getServiceDb();
  const [consumed] = await db
    .update(linkTransactions)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(linkTransactions.id, txId),
        eq(linkTransactions.userId, userId),
        eq(linkTransactions.provider, provider),
        isNull(linkTransactions.consumedAt),
        gt(linkTransactions.expiresAt, new Date())
      )
    )
    .returning();
  return consumed?.userId ?? null;
}

/** Server-decided success URL for a completed link. */
const LINKED_REDIRECT = (provider: string): string =>
  `/profile?linked=${provider}`;

/**
 * NextAuth configuration.
 * Exports authOptions for use in route handlers and server helpers.
 *
 * Note: No adapter with JWT strategy. Credentials provider manually manages users table.
 * Database sessions table is not used; JWT tokens stored in HttpOnly cookies instead.
 */
export const authOptions: NextAuthOptions = {
  pages: {
    // Prevent redirect to default NextAuth sign-in page
    signIn: "/",
  },
  session: {
    strategy: "jwt",
    // 30 days
    maxAge: 30 * 24 * 60 * 60,
  },
  secret: authSecret,
  // Rely on AUTH_SECRET or NEXTAUTH_SECRET in process.env
  providers: [
    Credentials({
      // Changed from "siwe" to match default RainbowKit adapter expectation
      id: "credentials",
      name: "Sign-In with Ethereum",
      credentials: {
        message: { label: "Message", type: "text" },
        signature: { label: "Signature", type: "text" },
      },
      async authorize(credentials, req) {
        try {
          if (!credentials?.message || !credentials?.signature) {
            getLog().error("[SIWE] Missing credentials");
            return null;
          }

          const siwe = new SiweMessage(credentials.message as string);
          const nextAuthUrl = new URL(
            process.env.NEXTAUTH_URL ?? "http://localhost:3000"
          );

          // Convert Headers to plain object for getCsrfToken
          const headers: Record<string, string> = {};
          if (req.headers instanceof Headers) {
            for (const [key, value] of req.headers.entries()) {
              headers[key] = value;
            }
          } else {
            Object.assign(headers, req.headers);
          }

          // Verify domain, nonce, and signature
          const nonce = await getCsrfToken({ req: { headers } });
          if (!nonce) {
            getLog().error("[SIWE] Failed to retrieve nonce");
            return null;
          }

          // [DEBUG] Log attempt details
          const messageHash = nodeCrypto
            .createHash("sha256")
            .update(credentials.message as string)
            .digest("hex")
            .slice(0, 8);
          getLog().info(
            {
              nonce,
              address: new SiweMessage(credentials.message as string).address,
              msgHash: messageHash,
            },
            "[SIWE] Authorize attempt"
          );

          const result = await siwe.verify({
            signature: credentials.signature as string,
            domain: nextAuthUrl.host,
            nonce,
          });

          if (!result.success) {
            getLog().error(
              { error: result.error },
              "[SIWE] Verification failed"
            );
            return null;
          }

          const { data: fields } = result;
          // Pre-auth wallet lookup must use serviceDb (BYPASSRLS) because
          // the user ID is unknown before authentication completes.
          // Per DATABASE_RLS_SPEC.md: SIWE auth callback uses app_service role.
          const db = getServiceDb();

          // Check for existing user
          const existingUser = await db.query.users.findFirst({
            where: eq(users.walletAddress, fields.address),
          });
          let user = existingUser;

          if (!user) {
            // Create new user if not exists
            const newUserId = randomUUID();
            const [newUser] = await db
              .insert(users)
              .values({
                id: newUserId,
                walletAddress: fields.address,
              })
              .returning();
            user = newUser;

            // Create empty profile row for new user
            if (user) {
              try {
                await db
                  .insert(userProfiles)
                  .values({ userId: user.id })
                  .onConflictDoNothing();
              } catch {
                getLog().warn(
                  { userId: user.id },
                  "[SIWE] Profile row creation failed — non-critical"
                );
              }
            }
          }

          if (!user) {
            getLog().error("[SIWE] Failed to create or retrieve user");
            return null;
          }

          // Record wallet binding (idempotent — skips if already bound).
          // Failure must not block login — binding is supplementary, not auth-critical.
          try {
            await createBinding(db, user.id, "wallet", fields.address, {
              method: "siwe",
              domain: nextAuthUrl.host,
            });
          } catch (bindingError) {
            getLog().warn(
              { error: bindingError, address: fields.address },
              "[SIWE] Binding insert failed — login continues"
            );
          }

          getLog().info({ address: fields.address }, "[SIWE] Login success");

          capture({
            event: AnalyticsEvents.AUTH_SIGNED_IN,
            identity: { userId: user.id, sessionId: randomUUID() },
            properties: { provider: "wallet", is_new_user: !existingUser },
          });

          // Always use DB UUID as primary ID
          return {
            id: user.id,
            walletAddress: fields.address,
          };
        } catch (e) {
          getLog().error({ error: e }, "[SIWE] Authorize error");
          return null;
        }
      },
    }),
    // Only register OAuth providers when credentials are configured
    ...(process.env.GH_OAUTH_CLIENT_ID && process.env.GH_OAUTH_CLIENT_SECRET
      ? [
          GitHub({
            clientId: process.env.GH_OAUTH_CLIENT_ID,
            clientSecret: process.env.GH_OAUTH_CLIENT_SECRET,
            issuer: GITHUB_OAUTH_ISSUER,
          }),
        ]
      : []),
    ...(process.env.DISCORD_OAUTH_CLIENT_ID &&
    process.env.DISCORD_OAUTH_CLIENT_SECRET
      ? [
          Discord({
            clientId: process.env.DISCORD_OAUTH_CLIENT_ID,
            clientSecret: process.env.DISCORD_OAUTH_CLIENT_SECRET,
          }),
        ]
      : []),
    ...(process.env.GOOGLE_OAUTH_CLIENT_ID &&
    process.env.GOOGLE_OAUTH_CLIENT_SECRET
      ? [
          Google({
            clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
            clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
          }),
        ]
      : []),
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      // SIWE (Credentials) flow: user already resolved in authorize(), pass through
      if (!account || account.provider === "credentials") return true;

      // Only handle known OAuth providers
      const KNOWN_OAUTH = new Set(["github", "discord", "google"]);
      if (!KNOWN_OAUTH.has(account.provider)) return false;

      const db = getServiceDb();
      const provider = account.provider as "github" | "discord" | "google";
      const externalId = account.providerAccountId;

      // Lookup existing binding
      const existing = await db.query.userBindings.findFirst({
        where: and(
          eq(userBindings.provider, provider),
          eq(userBindings.externalId, externalId)
        ),
      });

      // Check for link intent BEFORE returning-user shortcut.
      // If a link intent is active, the caller is trying to bind this external
      // account to their existing user — we must NOT silently log them in as
      // the binding owner if it's a different user.
      const linkIntent = linkIntentStore.getStore();

      // Fail-closed: if the link transaction could not be verified, reject immediately.
      // This prevents silent fall-through to new-user creation when the cookie was
      // lost, expired, tampered, or already consumed.
      if (isFailedIntent(linkIntent)) {
        getLog().warn(
          { provider, reason: linkIntent.reason },
          "[OAuth] Link intent rejected — fail-closed"
        );
        return "/profile?error=link_failed";
      }

      // Pending intent: atomically consume the DB transaction to verify it.
      // If consumption fails, reject — never fall through to new-user creation.
      let verifiedUserId: string | null = null;
      if (isPendingIntent(linkIntent)) {
        verifiedUserId = await consumeLinkTransaction(
          linkIntent.txId,
          linkIntent.userId,
          provider
        );
        if (!verifiedUserId) {
          getLog().warn(
            { provider, txId: linkIntent.txId },
            "[OAuth] Link tx consume failed — expired/consumed/mismatched"
          );
          return "/profile?error=link_failed";
        }
      }

      // SESSION_NEVER_SWITCHED_BY_OAUTH_CALLBACK (bug.5603): a callback that arrives
      // while a session exists but carries no verified link intent (cookie consumed by a
      // duplicate request, or never set) must not sign in as the binding owner. Keep the
      // current session and surface a fixed error. Signed-out sign-in is unchanged.
      const signedIn = signedInSessionStore.getStore();
      if (signedIn && !verifiedUserId) {
        getLog().warn(
          { provider, sessionUserId: signedIn.userId },
          "[OAuth] Callback with existing session and no verified link intent — refusing to switch account"
        );
        return "/profile?error=link_failed";
      }

      // Extract provider login from OAuth profile
      const profileData = profile as Record<string, unknown> | undefined;
      const oauthLogin =
        (profileData?.login as string | undefined) ??
        (profileData?.username as string | undefined) ??
        null;

      if (existing) {
        // Update provider login on existing binding
        if (oauthLogin) {
          try {
            await db
              .update(userBindings)
              .set({ providerLogin: oauthLogin })
              .where(eq(userBindings.id, existing.id));
          } catch {
            // Non-critical metadata update
          }
        }

        if (verifiedUserId) {
          if (existing.userId === verifiedUserId) {
            // Idempotent — already linked to this user. The server decides the
            // outcome URL; a client callbackUrl can never claim success. Returning
            // a URL ends the flow without minting a session: the current one stays.
            return LINKED_REDIRECT(provider);
          }
          // Different user owns this binding — NO_AUTO_MERGE
          getLog().warn(
            { provider, externalId },
            "[OAuth] Link rejected — binding owned by different user"
          );
          return "/profile?error=already_linked";
        }
        // Returning user (no link intent) — set user.id so jwt callback picks it up
        user.id = existing.userId;
        capture({
          event: AnalyticsEvents.AUTH_SIGNED_IN,
          identity: { userId: existing.userId, sessionId: randomUUID() },
          properties: { provider, is_new_user: false },
        });
        return true;
      }

      if (verifiedUserId) {
        await createBinding(db, verifiedUserId, provider, externalId, {
          method: "oauth_link",
          login: profileData?.login ?? profileData?.username ?? null,
          name: profileData?.name ?? null,
        });

        getLog().info(
          { provider, userId: verifiedUserId },
          "[OAuth] Account linked"
        );
        capture({
          event: AnalyticsEvents.IDENTITY_PROVIDER_LINKED,
          identity: { userId: verifiedUserId, sessionId: randomUUID() },
          properties: { provider },
        });
        // Server-truth outcome; the existing session is kept as-is (see above).
        return LINKED_REDIRECT(provider);
      }

      // New user — single transaction (user + binding + profile + event atomically).
      // If the binding insert is skipped (concurrent first-login race), the
      // transaction rolls back so no orphaned user row is committed.
      const BINDING_RACE = "BINDING_RACE";
      const userId = randomUUID();
      const bindingId = randomUUID();
      const eventId = randomUUID();

      try {
        await db.transaction(async (tx) => {
          await tx.insert(users).values({
            id: userId,
            name: (profileData?.name as string | null | undefined) ?? null,
            walletAddress: null,
          });
          const [inserted] = await tx
            .insert(userBindings)
            .values({
              id: bindingId,
              userId,
              provider,
              externalId,
              providerLogin: oauthLogin,
            })
            .onConflictDoNothing({
              target: [userBindings.provider, userBindings.externalId],
            })
            .returning({ id: userBindings.id });
          if (!inserted) {
            // Another request won the race — roll back (no orphaned user)
            throw new Error(BINDING_RACE);
          }
          await tx.insert(identityEvents).values({
            id: eventId,
            userId,
            eventType: "bind",
            payload: {
              provider,
              external_id: externalId,
              method: "oauth",
              login: oauthLogin,
            },
          });
          // Create empty profile row
          await tx
            .insert(userProfiles)
            .values({ userId })
            .onConflictDoNothing();
        });
      } catch (txError) {
        if (!(txError instanceof Error) || txError.message !== BINDING_RACE) {
          throw txError;
        }
        // Race lost — re-fetch the winning binding and use that user
        const winner = await db.query.userBindings.findFirst({
          where: and(
            eq(userBindings.provider, provider),
            eq(userBindings.externalId, externalId)
          ),
        });
        if (winner) {
          user.id = winner.userId;
          (user as { walletAddress?: string | null }).walletAddress = null;
          getLog().info(
            { provider, externalId },
            "[OAuth] Race resolved — using existing user"
          );
          return true;
        }
        getLog().error(
          { provider, externalId },
          "[OAuth] Binding race: no winner found"
        );
        return false;
      }

      user.id = userId;
      (user as { walletAddress?: string | null }).walletAddress = null;
      getLog().info({ provider, externalId }, "[OAuth] New user created");
      capture({
        event: AnalyticsEvents.AUTH_SIGNED_IN,
        identity: { userId, sessionId: randomUUID() },
        properties: { provider, is_new_user: true },
      });
      return true;
    },
    /** Redirect authenticated users to /chat instead of landing on homepage */
    redirect({ url, baseUrl }) {
      // Default post-sign-in lands on "/"; send to /chat instead
      if (url === baseUrl || url === `${baseUrl}/`) {
        return `${baseUrl}/chat`;
      }
      // Allow relative URLs
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      // Allow same-origin URLs
      if (url.startsWith(baseUrl)) return url;
      return baseUrl;
    },
    async jwt({ token, user, trigger }) {
      // ALWAYS explicitly set — NextAuth does not auto-forward custom fields
      if (user) {
        token.id = user.id;
        token.walletAddress =
          (user as { walletAddress?: string | null }).walletAddress ?? null;
      }

      // Load profile into token on initial sign-in or explicit update()
      if (user || trigger === "update") {
        try {
          const db = getServiceDb();
          const userId = (token.id as string) ?? user?.id;
          if (userId) {
            const profile = await db.query.userProfiles.findFirst({
              where: eq(userProfiles.userId, userId),
            });
            token.displayName = profile?.displayName ?? null;
            token.avatarColor = profile?.avatarColor ?? null;
          }
        } catch {
          // Non-critical — profile fields stay null
        }
      }
      return token;
    },
    async session({ session, token }) {
      // ALWAYS explicitly set — NextAuth does not auto-forward custom fields
      if (session.user) {
        session.user.id = token.id as string;
        session.user.walletAddress =
          (token.walletAddress as string | null) ?? null;
        session.user.displayName = (token.displayName as string | null) ?? null;
        session.user.avatarColor = (token.avatarColor as string | null) ?? null;
      }
      return session;
    },
  },
  // Enable debugging to diagnose login issues
  debug: process.env.NODE_ENV === "development",
};
