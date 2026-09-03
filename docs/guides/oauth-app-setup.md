---
id: oauth-app-setup-guide
type: guide
title: OAuth App Setup (GitHub + Google)
status: draft
trust: draft
summary: Register OAuth clients per environment for GitHub and Google. Covers the exact-callback-URL rule, the GitHub multi-URI trap that silently breaks existing URIs, the full route inventory including the identity broker, and where secrets live per environment.
read_when: Adding an OAuth provider, adding an environment, adding any new auth callback route, or debugging redirect_uri errors.
owner: derekg1729
created: 2026-02-28
verified: 2026-08-27
tags: [auth, oauth, setup]
---

# OAuth App Setup (GitHub + Google)

> **One OAuth client per environment. One registered redirect URI per callback route. Always the exact full URL.**
> Getting either half wrong fails at the provider, not in our code, and the error is unhelpful.

## The two rules that matter

**1. One client per environment — never share across prod and non-prod.**
A client is one client _secret_. Share it between production and a 48h throwaway preview box and the preview box now holds the credential guarding production sign-in.

**2. Register the EXACT full callback URL for every route. Never a prefix.**

| provider   | matching                                                                         | multiple URIs                                                                                                                        |
| ---------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Google** | always exact — no wildcards, no sub-paths, trailing slashes matter               | yes, many                                                                                                                            |
| **GitHub** | exact… **except** an app holding exactly ONE URI gets implicit wildcard matching | up to **10** (since [2026-08-14](https://github.blog/changelog/2026-08-14-multiple-redirect-uris-and-token-refresh-for-oauth-apps/)) |

### ⚠️ The GitHub trap — adding a URI silently breaks the ones already there

> _"Apps with only one redirect URI have wildcard matching enabled. This is a legacy behavior of GitHub that is now visible and controllable."_

An app registered as `https://test.cognidao.org/api/auth/` worked for **every** sub-path while it was the only URI. Adding a second URI switched the app to exact matching, and `/api/auth/attest/callback/github` began failing with:

> **Be careful!** The `redirect_uri` is not associated with this application.

The registration looks untouched and correct throughout. This cost a failed human validation on 2026-08-26 (`task.5024`).

**Therefore: register exact URLs from the start.** 10 slots exist; exactness is affordable. Prefer it over enabling wildcard matching, which grants _"any URL that matches a subdomain or additional path off of the redirect URI"_ — a real blast-radius increase on a fleet whose subdomains are node-controlled.

**You cannot detect this from a script.** Providers validate `redirect_uri` only _after_ the user is signed in, so an anonymous `curl` of the authorize URL returns the login page whether or not the URI is registered. Only a signed-in browser surfaces the mismatch. Do not trust a scripted probe here.

## How providers get registered

`src/auth.ts` registers each provider only when both `*_CLIENT_ID` and `*_CLIENT_SECRET` are set. No code change is needed to add one — but note the failure mode: **NextAuth advertises a provider whenever its credentials exist, regardless of whether the callback URL is registered.** A provider showing up on the sign-in page is not evidence that it works.

## GitHub sends `iss` now — a provider without an `issuer` cannot complete sign-in

GitHub adopted **RFC 9207** (Authorization Server Issuer Identification) in April 2026 and now returns `iss=https://github.com/login/oauth` on every authorization response.

`openid-client` branches on the parameter's mere presence — `if ('iss' in params) assertIssuerConfiguration(this.issuer, 'issuer')` — and NextAuth's GitHub provider declares **no** `issuer`, so the assert throws and every callback dies:

| where   | what you see                                                                             |
| ------- | ---------------------------------------------------------------------------------------- |
| browser | bounced to `/?error=OAuthCallback` — no detail, reads like a config problem              |
| Loki    | `[OAUTH_CALLBACK_ERROR] issuer must be configured on the issuer`, `providerId: 'github'` |

**Fix — one line in `src/auth.ts`:**

```ts
GitHub({ clientId, clientSecret, issuer: "https://github.com/login/oauth" });
```

The value must byte-match what GitHub sends. A wrong one fails loudly and specifically (`iss mismatch, expected X, got: Y`), so pin it rather than guess.

**Google is immune** — its provider discovers `wellKnown`, which populates `issuer` already. Any hand-rolled OAuth2 provider with no `issuer` is exposed the moment its upstream adopts RFC 9207; Discord is the next candidate in our own config.

**This was live and unnoticed for four months** (`bug.5071`): prod Loki showed 3/3 sign-in attempts failing over 28 days, because nothing alerts on a user-facing auth bounce. Diagnosing it from the browser is impossible — the URL says `OAuthCallback` whether the cause is the issuer assert, a bad code, or a state mismatch. Drive a real signin to obtain a matching `state` cookie, replay the callback with `code`+`state`+`iss`, and read the Loki message; that is the only thing that discriminates.

## Nodes do NOT register a GitHub OAuth app — they never will

A relying node holds **no GitHub client, no secret, and no redirect URI of its own**. The operator holds the environment's single client and brokers on the node's behalf (`fleet-github-oauth-constraint`), so seeding `GH_OAUTH_*` into a node is the anti-pattern this design exists to prevent — it puts the fleet's client secret on every node and costs one settings edit per node per env against a hard 10-URI ceiling.

A node's GitHub button is the `operator-github` **Credentials** provider (`task.5042`). It accepts only an EdDSA attestation the operator already signed, verified against the operator's JWKS. Two consequences that bite:

- **It is not an OAuth provider.** Handing it to `signIn()` posts an empty credential and bounces with `?error=CredentialsSignin`. It must take the broker round trip first (`POST /api/v1/identity/bindings/import/start`, then follow `authorizeUrl`).
- **Adding a node needs zero OAuth work.** No app, no URI, no secret — if a new node lacks the button, the cause is deployment (see `bug.5076`/`bug.5077`), never OAuth registration.

## Route inventory — every callback that needs registering

Auth callbacks live under `/api/auth/`. That path tree sits outside the proxy's session gate, which is why they work unauthenticated.

| route                              | provider | purpose                                                                         |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------- |
| `/api/auth/callback/github`        | GitHub   | sign-in                                                                         |
| `/api/auth/callback/google`        | Google   | sign-in                                                                         |
| `/api/auth/callback/discord`       | Discord  | sign-in                                                                         |
| `/api/auth/attest/callback/github` | GitHub   | **identity broker** — attests a GitHub account for a relying node (`task.5024`) |

Grouping the broker under `/api/auth/` buys tidiness, **not** free registration. Every new auth route costs one settings edit at the provider. Budget for it.

## Environment matrix

| env         | base URL                       | client                          | secrets live in                                |
| ----------- | ------------------------------ | ------------------------------- | ---------------------------------------------- |
| local       | `http://localhost:3000`        | non-prod client                 | `.env.local`                                   |
| candidate-a | `https://test.cognidao.org`    | non-prod client                 | OpenBao `cogni/candidate-a/operator/*` via ESO |
| preview     | `https://preview.cognidao.org` | non-prod client                 | OpenBao `cogni/preview/operator/*` via ESO     |
| production  | `https://cognidao.org`         | **production client (its own)** | OpenBao `cogni/production/operator/*` via ESO  |

For deployed environments the GitHub env secret is only a provision-time seed — the running pod reads OpenBao. Use `pnpm secrets:set <env> operator GH_OAUTH_CLIENT_ID …` and bounce the pod.

### The actual app inventory

Three apps for four environments. The split is by **blast radius**, not by host count.

| app                                                                                                | client ID              | serves                    | redirect URIs                                                                                           |
| -------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `cogni-template-dev` ([3425496](https://github.com/settings/applications/3425496))                 | `Ov23livIPNUGpeVnUoUv` | **local only**            | `http://localhost:3000/api/auth/callback/github`, `.../api/auth/attest/callback/github`                 |
| `cogni-developers` ([2966520](https://github.com/settings/applications/2966520), org `Cogni-1729`) | `Ov23liCiArFHz9X7oyla` | **candidate-a + preview** | 4 URLs: `{test,preview}.cognidao.org` × `{/api/auth/callback/github, /api/auth/attest/callback/github}` |
| production ([2966454](https://github.com/settings/applications/2966454))                           | `Ov23lirY21xiXmFej5IP` | **production only**       | `https://cognidao.org/api/auth/callback/github`, `.../api/auth/attest/callback/github`                  |

**Why candidate-a and preview deliberately share one app.** Both are non-production, neither holds real user data, and a compromise of one is not materially worse than a compromise of the other. Rule 1 is about keeping **production's** secret off throwaway hosts — it does not demand a client per hostname. Since GitHub allows 10 redirect URIs, both hosts register their own exact URLs on the shared app and both work.

**Why local does NOT join them.** `cogni-developers` is an org app intended for deployed environments; a developer laptop should not hold a credential that also authenticates a deployed host. Local keeps `cogni-template-dev`.

> This supersedes an earlier reading of `bug.5061`, which treated candidate-a and preview sharing a client as the defect. The real defect was that they shared a client while **only one host's URLs were registered**, so the other silently failed — plus candidate-a declared no client of its own and inherited one by accident. Sharing with all four URLs registered is a deliberate, documented choice.

---

---

## 1. GitHub OAuth Apps

A GitHub OAuth App holds up to 10 redirect URIs, so one non-prod app covers local + candidate-a + preview. Production still gets its own app — see rule 1. Re-read the trap above before adding a URI to an existing app.

### 1a. Create the Dev App

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
   (`https://github.com/settings/applications/new`)

2. Fill in:

   | Field                      | Value                                            |
   | -------------------------- | ------------------------------------------------ |
   | Application name           | `cogni-template-dev`                             |
   | Homepage URL               | `https://test.cognidao.org`                      |
   | Authorization callback URL | `http://localhost:3000/api/auth/callback/github` |

   Then **Add redirect URI** for every remaining non-prod route, all at once:

   ```
   http://localhost:3000/api/auth/attest/callback/github
   https://test.cognidao.org/api/auth/callback/github
   https://test.cognidao.org/api/auth/attest/callback/github
   ```

   > Add them **now**, not later. Registering one URI and adding a second afterwards is
   > precisely the trap above — the first URI's matching behaviour changes underneath you.

3. Click **Register application**

4. On the app page:
   - Copy the **Client ID**
   - Click **Generate a new client secret** — copy it immediately (you won't see it again)

5. Add to `.env.local`:

   ```env
   GH_OAUTH_CLIENT_ID=<your-dev-client-id>
   GH_OAUTH_CLIENT_SECRET=<your-dev-client-secret>
   ```

### 1b. Create the Production App

Repeat the same steps with production values:

| Field                      | Value                                           |
| -------------------------- | ----------------------------------------------- |
| Application name           | `Cogni`                                         |
| Homepage URL               | `https://cognidao.org`                          |
| Authorization callback URL | `https://cognidao.org/api/auth/callback/github` |

Add the credentials to your production environment (Vercel, Railway, etc.) as `GH_OAUTH_CLIENT_ID` and `GH_OAUTH_CLIENT_SECRET`.

### GitHub Checklist

- [ ] Dev app created, credentials in `.env.local`
- [ ] Production app created, credentials in production env
- [ ] Dev sign-in tested (creates user + `user_bindings` row with `provider=github`)

---

## 2. Google OAuth Clients

Google uses one project with multiple clients. **Create a separate client for production** — rule 1 applies to Google exactly as it does to GitHub: one client is one client secret, and production's must not live on a non-prod host.

Google is stricter than GitHub and, usefully, has **no trap**: redirect URIs are always matched **exactly**, wildcards are not supported at all, and trailing slashes are significant. So there is no implicit-wildcard behaviour to lose — but it also means the prefix shortcut never works here. Register every full callback URL.

Google has no equivalent of the identity broker route today; it needs only `/api/auth/callback/google` per environment.

### 2a. Set Up the Google Cloud Project (once)

1. Go to **Google Cloud Console → APIs & Services → Credentials**
   (`https://console.cloud.google.com/apis/credentials`)

2. Create a project if you don't have one (e.g. `cogni`)

3. **Configure the OAuth consent screen** (left sidebar → OAuth consent screen):

   | Field              | Value                        |
   | ------------------ | ---------------------------- |
   | User Type          | **External**                 |
   | App name           | `Cogni`                      |
   | User support email | your email                   |
   | Scopes             | `email`, `profile`, `openid` |
   | Test users         | add your Google email(s)     |

   > While the app is in **Testing** status, only listed test users can sign in (100 user cap). This is fine for dev. Submit for verification when you're ready for production.

### 2b. Create the Dev Client

1. Go to **Credentials → Create Credentials → OAuth client ID**

2. Fill in:

   | Field                         | Value                                                                                                  |
   | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
   | Application type              | **Web application**                                                                                    |
   | Name                          | `cogni-nonprod`                                                                                        |
   | Authorized JavaScript origins | `http://localhost:3000`, `https://test.cognidao.org`                                                   |
   | Authorized redirect URIs      | `http://localhost:3000/api/auth/callback/google`, `https://test.cognidao.org/api/auth/callback/google` |

3. Click **Create** — copy the **Client ID** and **Client Secret**

4. Add to `.env.local`:

   ```env
   GOOGLE_OAUTH_CLIENT_ID=<your-dev-client-id>
   GOOGLE_OAUTH_CLIENT_SECRET=<your-dev-client-secret>
   ```

### 2c. Create the Production Client

Create a second OAuth client ID in the same project:

| Field                         | Value                                           |
| ----------------------------- | ----------------------------------------------- |
| Application type              | **Web application**                             |
| Name                          | `Cogni`                                         |
| Authorized JavaScript origins | `https://cognidao.org`                          |
| Authorized redirect URIs      | `https://cognidao.org/api/auth/callback/google` |

Add the credentials to your production environment as `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.

### Google Checklist

- [ ] Google Cloud project created, consent screen configured
- [ ] Dev client created, credentials in `.env.local`
- [ ] Production client created, credentials in production env
- [ ] Test users added to consent screen (required while in Testing mode)
- [ ] Dev sign-in tested (creates user + `user_bindings` row with `provider=google`)

---

## Verify

After adding env vars, restart the dev server:

```bash
pnpm dev
```

Providers auto-register when both `CLIENT_ID` and `CLIENT_SECRET` are non-empty (`src/auth.ts:203-226`). No code changes or feature flags needed.

### What to Check

1. **Sign in** via GitHub or Google from the sign-in page
2. **User created** — `users` row with `walletAddress: null`
3. **Binding created** — `user_bindings` row with correct `provider` and `external_id`
4. **Session** — `session.user.id` is a UUID, `session.user.walletAddress` is `null`
5. **Idempotent** — signing in again with the same account returns the same user

### Account Linking

If you're already signed in (e.g. via wallet), you can link an OAuth provider from the profile page. This creates a binding for your existing user instead of creating a new one. See the [authentication spec](../spec/authentication.md) for details.

---

## Env Var Reference

| Variable                     | Required | Where                   |
| ---------------------------- | -------- | ----------------------- |
| `NEXTAUTH_URL`               | Yes      | `.env.local`            |
| `NEXTAUTH_SECRET`            | Yes      | `.env.local`            |
| `GH_OAUTH_CLIENT_ID`         | No\*     | `.env.local` / prod env |
| `GH_OAUTH_CLIENT_SECRET`     | No\*     | `.env.local` / prod env |
| `GOOGLE_OAUTH_CLIENT_ID`     | No\*     | `.env.local` / prod env |
| `GOOGLE_OAUTH_CLIENT_SECRET` | No\*     | `.env.local` / prod env |

\*Optional — provider is silently skipped if either value is missing.

---

## Troubleshooting

| Symptom                                                                                                | Cause                                                                                                                                                                      | Fix                                                                                                         |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Provider not showing on sign-in                                                                        | Missing or empty `CLIENT_ID` / `CLIENT_SECRET`                                                                                                                             | Check `.env.local`, restart dev server                                                                      |
| "redirect_uri_mismatch" (Google)                                                                       | Callback URL doesn't match registered redirect URI                                                                                                                         | Verify exact URL in Google Cloud Console (trailing slashes matter)                                          |
| "redirect_uri_mismatch" (GitHub)                                                                       | Callback URL doesn't match registered callback URL                                                                                                                         | Verify exact URL in GitHub OAuth App settings                                                               |
| GitHub "Be careful! The `redirect_uri` is not associated with this application"                        | The exact URL is not registered. **Most often: someone added a second redirect URI, which turned off the legacy implicit wildcard that was covering a registered prefix.** | Register the exact full callback URL for every route (see rule 2). Do not assume a prefix covers sub-paths. |
| GitHub sign-in bounces to `/?error=OAuthCallback`, Loki says `issuer must be configured on the issuer` | GitHub sends RFC 9207 `iss`; the provider declares no `issuer`                                                                                                             | Add `issuer: "https://github.com/login/oauth"` to the GitHub provider (`bug.5071`)                          |
| A node shows no GitHub button                                                                          | Nodes register no GitHub provider by design; the button is `operator-github` and appears only when that node's build carries `task.5042`                                   | Check the node's deployed sha, not OAuth config — `GET <node>/api/auth/providers`                           |
| A node's GitHub button bounces with `?error=CredentialsSignin`                                         | `operator-github` was handed to `signIn()` directly; it has no credential until the broker mints one                                                                       | Route it through the start leg, then follow `authorizeUrl`                                                  |
| Provider listed on sign-in but the round trip dies at the provider                                     | Credentials are set, so NextAuth advertises it — but the callback URL is unregistered. Presence on the sign-in page proves nothing.                                        | Register the exact callback URL                                                                             |
| Anonymous `curl` of the authorize URL "passes" but a browser fails                                     | Providers validate `redirect_uri` only after sign-in                                                                                                                       | Test in a signed-in browser; scripted probes give false passes                                              |
| Google "Access blocked" screen                                                                         | App in Testing mode, your email not in test users list                                                                                                                     | Add your email to OAuth consent screen → Test users                                                         |
| Google "unverified app" warning                                                                        | App not verified (expected in dev)                                                                                                                                         | Click "Advanced" → "Go to Cogni (unsafe)" to proceed                                                        |
| Sign-in succeeds but no user row                                                                       | DB connection issue                                                                                                                                                        | Check Postgres is running, `DATABASE_URL` is correct                                                        |

## Related

- [Authentication Spec](../spec/authentication.md) — full auth flow design, invariants, session model
- [Identity Model](../spec/identity-model.md) — `user_id`, `user_bindings`, identity primitives
- [Developer Setup](./developer-setup.md) — general env setup
- [Decentralized User Identity](../spec/decentralized-user-identity.md) — the operator-brokered attestation a node's GitHub button actually uses
