---
id: guide.pr-screenshots
type: guide
title: "UI Update Validation Process"
status: draft
trust: draft
summary: Step-by-step guide for taking desktop and mobile screenshots of the operator UI from a dev worktree and publishing them to a pull request via GitHub release assets.
read_when: You are adding visual evidence to a UI pull request and need to capture and upload screenshots programmatically.
owner: derekg1729
created: 2026-04-08
verified:
tags: [playwright, screenshots, pr, ui, workflow]
---

# UI Update Validation Process

Capture and publish desktop plus mobile screenshots for UI pull requests.

## Prerequisites

- `playwright-cli` installed globally (`npm i -g playwright-cli`)
- `gh` CLI authenticated
- Dev server or canary site accessible

## Full workflow

### 1. Start the dev server from the worktree

```bash
cd nodes/operator/app
npx next dev --port 3099 &>/tmp/next-dev.log &

until curl -s -o /dev/null -w "%{http_code}" http://localhost:3099/ | rg "^200$"; do sleep 2; done
echo "Ready"
```

Use a non-standard port such as `3099` to avoid conflicting with the main dev workflow on `3000`.

### 2. Capture auth state once per target

Create local-only auth-state files:

```bash
mkdir -p e2e/.auth
```

For local dev:

```bash
playwright-cli -s=local-auth open http://localhost:3099/
# Sign in manually in the opened browser.
playwright-cli -s=local-auth state-save e2e/.auth/local-dev.json
playwright-cli -s=local-auth close
```

For canary:

```bash
playwright-cli -s=canary-auth open https://<your-canary-domain>/
# Sign in manually in the opened browser.
playwright-cli -s=canary-auth state-save e2e/.auth/canary.json
playwright-cli -s=canary-auth close
```

These files stay on your machine and should never be committed.

### 3. Reuse saved auth state for authenticated validation

Run the authenticated Playwright validation against local dev:

```bash
TEST_BASE_URL=http://localhost:3099 \
PLAYWRIGHT_AUTH_STATE=e2e/.auth/local-dev.json \
pnpm e2e:file -- e2e/tests/full/chat-model-selection.spec.ts
```

Run the same validation against canary:

```bash
TEST_BASE_URL=https://<your-canary-domain> \
PLAYWRIGHT_AUTH_STATE=e2e/.auth/canary.json \
pnpm e2e:file -- e2e/tests/full/chat-model-selection.spec.ts
```

The Playwright config automatically loads `PLAYWRIGHT_AUTH_STATE` when present.

### 4. Reuse saved auth state for screenshots

For local dev:

```bash
playwright-cli -s=shot-local open http://localhost:3099/
playwright-cli -s=shot-local state-load e2e/.auth/local-dev.json
playwright-cli -s=shot-local goto http://localhost:3099/chat
playwright-cli -s=shot-local resize 1440 900
sleep 3
playwright-cli -s=shot-local screenshot --filename=/tmp/chat-desktop.png
playwright-cli -s=shot-local resize 390 844
sleep 2
playwright-cli -s=shot-local screenshot --filename=/tmp/chat-mobile.png
playwright-cli -s=shot-local close
```

Swap in `e2e/.auth/canary.json` and the canary URL to capture authenticated canary screenshots.

### 5. Upload to GitHub via release assets

GitHub's `user-attachments` CDN is browser-only. Use a pre-release as an image host instead:

```bash
PR_NUMBER=827

gh release create "pr-${PR_NUMBER}-screenshots" \
  --repo Cogni-DAO/node-template \
  --title "PR #${PR_NUMBER} Screenshots" \
  --notes "Image host for PR #${PR_NUMBER} — can be deleted after merge." \
  --prerelease \
  /tmp/chat-desktop.png \
  /tmp/chat-mobile.png
```

### 6. Add screenshots to the PR body

```bash
gh pr edit $PR_NUMBER --repo Cogni-DAO/node-template --body "$(cat <<'BODY'
## Screenshots

**Desktop (1440×900)**

<img width="1440" alt="chat-desktop" src="https://github.com/Cogni-DAO/node-template/releases/download/pr-NNN-screenshots/chat-desktop.png" />

**Mobile (390×844)**

<img width="390" alt="chat-mobile" src="https://github.com/Cogni-DAO/node-template/releases/download/pr-NNN-screenshots/chat-mobile.png" />

---

[... rest of existing PR body ...]
BODY
)"
```

### 7. Clean up

```bash
kill $(lsof -ti :3099)
rm -f /tmp/chat-desktop.png /tmp/chat-mobile.png
```

## Notes

- `PLAYWRIGHT_AUTH_STATE` is the only extra variable needed for authenticated Playwright runs.
- Keep `e2e/.auth/*.json` local-only. They contain your real authenticated browser session.
- This is the fast local workflow. A future CI-safe path can replace manual sign-in with a deterministic `APP_ENV=test` auth bootstrap.
