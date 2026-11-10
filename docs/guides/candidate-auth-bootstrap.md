---
id: guide.candidate-auth-bootstrap
type: guide
title: Candidate Auth Bootstrap — Authed Playwright via CDP Attach
status: draft
trust: draft
summary: Capture a reusable signed-in browser session for candidate-a envs via a dedicated Chrome profile + MetaMask + CDP-attach export, so AI agents can drive authed Playwright flows without re-prompting signin.
read_when: Setting up the candidate-auth Chrome profile, capturing a new env's storageState, or troubleshooting why a captured session no longer authenticates
owner: derekg1729
created: 2026-04-24
verified: null
tags: [auth, playwright, candidate-a, validate, metamask]
---

# Candidate Auth Bootstrap — Authed Playwright via CDP Attach

> Goal: capture a reusable signed-in browser session for `{env}.cognidao.org` so AI agents (Claude, qa-agent) can drive authed Playwright flows without re-prompting MetaMask on every run.
>
> Human effort: one-time MetaMask install into a dedicated Chrome profile (~2 min), then 1–2 clicks to sign in per env. Recapture when the session cookie expires (days–weeks).

## Why this exists

Playwright launches a fresh Chromium profile with no extensions — MetaMask and other wallet extensions therefore do not work in the normal `browser.newContext()` flow. Work around it by launching **a dedicated Chrome profile** (with MetaMask installed), signing in once, then exporting the resulting session cookies via CDP attach. Future Playwright runs load the exported `storageState.json` and are authenticated without needing a wallet at all.

The session cookie is the auth artifact. MetaMask only participates in the _first_ signin to mint the cookie.

## Why a dedicated profile (not your default Chrome)

Chrome 136+ **disables** `--remote-debugging-port` when launched against the default user data dir, as a security mitigation (default profile cookies are an attractive target for malware using CDP). A dedicated profile dir bypasses this cleanly. One-time MetaMask install into the new profile is the only setup cost.

## Storage layout

```
~/.playwright-profiles/
  cogni-wallet-auth/                        # canonical shared Chrome profile; MetaMask lives here

<repo>/.local-auth/                         # gitignored; commonly symlinked to the canonical checkout
  credentials.md                            # MetaMask password + recovery phrase (test wallet only)
  candidate-a-poly.storageState.json        # poly-test.cognidao.org
  candidate-a-operator.storageState.json    # test.cognidao.org
  ...
```

Root `.gitignore` excludes the entire `/.local-auth/` directory. Never commit — these files hold live session cookies. The wallet profile is global so every Conductor worktree reuses the same installed MetaMask vault; never create a second profile under `.local-auth/chrome-profile`.

> **Future state:** this whole stack is a crawl-step MVP wedge. Long-term it should be:
>
> - test wallet seed in a secrets manager (1Password CLI / Doppler), not a gitignored markdown file
> - first-class commands `pnpm auth:capture <node> <env>` + `pnpm auth:verify <node> <env>` driven by the node × env matrix
>
> Tracked under `proj.agent-dev-testing.md` Run (P2+) — "Playwright + Chromium in devtools image" milestone.

## One-time setup (per laptop)

1. **Quit all Chrome windows** (⌘Q). Verify nothing is running: `pgrep -lf "Google Chrome"` should be empty.
2. Launch Chrome pointed at the dedicated profile, with CDP enabled:

   ```bash
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
     --remote-debugging-port=9222 \
     --user-data-dir="$HOME/.playwright-profiles/cogni-wallet-auth"
   ```

   Keep that terminal tab open — closing it kills Chrome.

3. **Install MetaMask** into this profile:
   - **Skip / reject every Google sign-in prompt.** Don't sign into Chrome with a Google account, don't enable sync, dismiss any "Turn on sync" banners. This profile is a throwaway test rig — signing in pollutes it with your real identity and defeats the isolation.
   - Go to `https://chrome.google.com/webstore/detail/metamask/nkbihfbeogaeaoehlefnkodbefgpgknn`
   - Click "Add to Chrome"
   - MetaMask setup: choose **Create a new wallet** (preferred) or **Import existing** if you already have a dedicated test seed.
   - **Suggested password:** `cogni-is-the-goat` (low-stakes — this profile is test-only and gitignored). If you pick something else, write it down in `.local-auth/credentials.md` so the next agent/session can unlock.
   - Finish setup. MetaMask shows you a 12-word recovery phrase — **save it into `.local-auth/credentials.md` immediately**. That file is gitignored. Without it, a wiped profile means a lost wallet.
   - **Seed confirmation step:** MetaMask then asks the user to fill in 3 specific word positions (e.g. "2, 5, 8") from a shuffled word pool. The AI agent should read `.local-auth/credentials.md`, map the requested positions to the saved phrase, and tell the user exactly which word goes in each slot. Don't make the user count words manually.
   - Unlock MetaMask.

4. Verify CDP is listening:

   ```bash
   curl -s http://localhost:9222/json/version | jq .Browser
   # -> "Chrome/<version>"
   ```

The profile now persists under `~/.playwright-profiles/cogni-wallet-auth/`. Future launches from any worktree reuse it — MetaMask stays installed and funded with the account you imported.

## Per-environment: sign in and capture

1. In the debuggable Chrome, navigate to the target env (e.g. `https://poly-test.cognidao.org`).
2. Sign-in is typically **2 MetaMask prompts** (up to 4 clicks total):
   - Click "Sign in" / "Connect wallet"
   - MetaMask **Connect** popup → approve the connection
   - Site then issues a SIWE message
   - MetaMask **Sign** popup → sign the message
3. Confirm you're signed in (avatar/account visible, or redirect to an authed page).
4. **Leave that tab open**, then from the repo root:

   ```bash
   node scripts/dev/capture-authed-state.mjs candidate-a-poly https://poly-test.cognidao.org
   ```

   Writes `.local-auth/candidate-a-poly.storageState.json` and prints cookie/domain counts as sanity check.

## Using captured state

Two valid consumers:

**1. Ad-hoc / `/validate-candidate` skill — `playwright-cli`** (preferred for one-off validation runs):

```bash
playwright-cli -s=validate open about:blank
playwright-cli -s=validate state-load .local-auth/candidate-a-poly.storageState.json
playwright-cli -s=validate goto https://poly-test.cognidao.org
playwright-cli -s=validate snapshot
playwright-cli -s=validate close
```

**2. Committed Playwright test files — `@playwright/test`** (for code that lives in the repo and runs in CI):

```ts
import { chromium } from "@playwright/test";
import path from "node:path";

const storageState = path.join(
  process.cwd(),
  ".local-auth/candidate-a-poly.storageState.json"
);

const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState });
const page = await ctx.newPage();
await page.goto("https://poly-test.cognidao.org");
// already signed in — no MetaMask needed
```

The two paths read the **same JSON schema** — `playwright-cli state-save` and `@playwright/test` `storageState` are interchangeable. Pick by context: validation runs use the CLI (zero artifacts, snapshot-driven); committed tests use the library API.

## Refresh cadence

- Sessions generally persist for days to weeks depending on the env's cookie TTL.
- When an agent run hits "unauthenticated", re-run the sign-in + capture flow. MetaMask is only needed to re-mint the cookie.
- Clearing `~/.playwright-profiles/cogni-wallet-auth/` wipes MetaMask — you'd have to re-import the seed phrase.

## Troubleshooting

- **`curl localhost:9222` refused but Chrome is running:** you pointed `--user-data-dir` at the default Chrome profile. Chrome 136+ blocks CDP there. Use `~/.playwright-profiles/cogni-wallet-auth/` as shown.
- **Chrome opens but MetaMask is missing:** you launched the obsolete worktree-local `.local-auth/chrome-profile`. Quit only that debug-profile Chrome instance and relaunch with `~/.playwright-profiles/cogni-wallet-auth`; verify `chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn` appears in `http://localhost:9222/json/list`.
- **Still refused with dedicated profile:** another Chrome instance is holding the profile lock. Run `pgrep -lf "Google Chrome"`, kill stragglers, retry.
- **MetaMask popup doesn't appear on signin:** unlock the extension (click the fox icon, enter password). Extensions stay locked across Chrome restarts.
- **The recorded password is rejected:** do not recreate the Chrome profile. Use MetaMask's **Forgot password / Restore Vault** flow with the 12-word recovery phrase in `.local-auth/credentials.md`, set a new password, and immediately update the recorded password. Restoring the vault preserves the deterministic test wallet while reinstalling or creating a wallet can silently change the candidate identity.
- **Captured state has no cookies for the expected domain:** you signed in before the capture script could see the tab. Make sure the tab is still open at the target URL when you run the script.
- **Playwright runs but site redirects to signin:** cookie expired — recapture. _Or:_ the site stores auth in `localStorage` rather than cookies, and CDP-attach export reports `origins: 0`. In that case the captured `storageState.json` is insufficient; a dedicated Playwright authfile step (using `browser.newContext({ storageState })` against a Playwright-launched browser + manual signin inside Playwright) may be needed. Tracked as a known gap — update this guide when resolved.

## Done for the session — getting back to your normal browser

When you're finished capturing state:

1. **Fully quit** the debuggable Chrome window: ⌘Q inside that window (closing via the red dot does not quit the process). The agent can also kill it by PID: `pgrep -f "remote-debugging-port" | xargs kill`.
2. Open Chrome normally from Applications / Spotlight / Dock — it launches with your real default profile (bookmarks, extensions, history all there).

Notes:

- The macOS "default browser" setting is **app-level**, not profile-level. If macOS prompted "Make Chrome your default browser" when the debug profile launched, nothing meaningful changed — Chrome-the-app is still the default either way.
- You **can run both at once**: the debug profile and your normal profile coexist as separate Chrome processes because they point at different `--user-data-dir`s. Launch one with the debug flag + `~/.playwright-profiles/cogni-wallet-auth/`, open the other from the Dock. The only conflict is two processes sharing one profile dir (Chrome refuses that with a lock-file error). When both are running, macOS may open new-window link clicks in whichever Chrome launched most recently — keep that in mind while automating.

## Scope / non-goals

- Per-developer primitive. Multi-tenant / credential-broker flows for production agents are tracked separately (see `spike.0230`).
- No headless capture — signin is inherently interactive.
- Not for CI — CI uses API-key or service-account auth, not SIWE.
