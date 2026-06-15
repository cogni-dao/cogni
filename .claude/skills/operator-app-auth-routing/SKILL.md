---
name: operator-app-auth-routing
description: Use this skill when changing operator app auth routing, Next.js public vs app route groups, `proxy.ts` route protection, auth-aware public chrome, `AccountSlot`, NextAuth session identity, wallet Connect button state, `/api/v1` auth rules, or route matcher tests. Trigger on requests involving `/nodes`, `/dashboard`, `/knowledge`, public-but-auth-aware pages, stale Connect state after login, or proxy matcher drift.
---

# Operator App Auth Routing

Keep page placement, chrome state, and auth enforcement separate. `proxy.ts` is the routing contract; route groups and UI chrome should not become alternate auth systems.

## Route Groups

- Public pages live under `nodes/operator/app/src/app/(public)/...`.
- Authenticated app pages live under `nodes/operator/app/src/app/(app)/...`.
- A public route may still be auth-aware. Example: `/nodes` can stay public while showing session-aware account chrome.
- Moving a page between route groups is not enough to change auth. Update `proxy.ts` and its tests when access changes.
- Operator is the node-gallery host. Its own detail page is `/nodes/operator`; other nodes are node-at-root apps on their own subdomains unless their local validation guide says otherwise.

## Proxy Rules

- Treat `nodes/operator/app/src/proxy.ts` as the primary authority for page redirects and `/api/v1` early rejection.
- Keep `APP_ROUTES` and `config.matcher` in sync. Matcher drift caused `/dashboard` and `/knowledge` regressions before.
- App routes redirect unauthenticated users to `/`; authenticated users on `/` redirect to `/chat`.
- Do not add client-side auth redirects for page protection. Client components can render auth-aware states, but proxy owns access decisions.

## Public Chrome

- Use `AccountSlot` for shared identity chrome in public and app headers.
- `AccountSlot` uses `useSession()` from NextAuth as the identity source. Wallet connection state is only for starting sign-in when no session exists.
- Authenticated users should see the user menu and optional app link, never a stale Connect call-to-action just because wallet state lags.
- If public chrome looks wrong after login, fix the session-aware component path before adding wallet-state special cases.

## API Rules

- `/api/v1/public/*` is unauthenticated by namespace.
- `/api/v1/agent/register` is unauthenticated by explicit exception.
- Other `/api/v1/*` routes require a NextAuth session unless they carry a `Bearer cogni_ag_sk_v1_...` agent token.
- Proxy only provides early rejection. Route handlers must still enforce their own auth and identity rules server-side.

## Tests To Update

- Update `nodes/operator/app/tests/unit/auth/proxy-routing.test.ts` whenever an app route, public route, API exception, or matcher changes.
- Add both unauthenticated and authenticated assertions for new app routes.
- Include nested route examples for path families such as `/knowledge/:id`.
- Assert public/auth-aware routes pass through without becoming app routes.
- For chrome behavior, add focused component tests around `AccountSlot` or the header using mocked NextAuth session state.

## Candidate Validation

- Keep `nodes/operator/.cogni/validation.md` in sync with operator public routes, app routes, and auth expectations.
- `/validate-candidate` reads node-local validation guides to choose human-axis routes. If this skill changes route policy, update that guide too.
- Validate `/nodes/operator` only for operator gallery/detail changes. For non-operator nodes, validate the node's root/app pages on its own candidate subdomain.

## Pitfalls

- Public does not mean session-blind. `/nodes` can be public and still render auth-aware account controls.
- Route group folders do not enforce auth. `proxy.ts` does.
- `APP_ROUTES` without a matching `config.matcher` entry silently skips proxy execution.
- `config.matcher` without a matching `APP_ROUTES` entry runs proxy but may pass through unexpectedly.
- Wallet `isConnected` is not user identity. NextAuth session is the source of truth for logged-in UI.
