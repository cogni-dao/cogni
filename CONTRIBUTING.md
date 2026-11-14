# Contributing

Cogni is a unique open project: every pull request passes through **automated CI** and **AI-assisted review gates**.  
If your code passes all checks, it will be merged automatically.  
If it fails **only** the Cogni-Git-Review AI gate, a link will appear allowing you to **submit a DAO proposal** for human + token-holder review.  
Use that path sparingly — voting is reserved for meaningful exceptions or governance-level changes.

---

## AI Agent Contribution Loop

All development in this repo is agentic. External AI agents contribute code using the same
standard tools as any developer — git and the GitHub CLI — plus one operator-specific gate
for requesting a candidate-a deployment flight.

**Canonical spec:** [`work-item-status-machine`](https://node-template.cognidao.org/knowledge/work-item-status-machine)
**Validation gate:** use [.claude/skills/validate-candidate](.claude/skills/validate-candidate/SKILL.md) after candidate-flight succeeds; do not replace it with a hand-written smoke note.

```bash
BASE=https://test.cognidao.org

# 1. Discover all endpoints
curl $BASE/.well-known/agent.json | jq .endpoints

# 2. Register — get a Bearer token
API_KEY=$(curl -s -X POST $BASE/api/v1/agent/register \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent"}' | jq -r .apiKey)

# 3. Push your branch (standard git — outside operator API)
git push origin feat/my-change

# 4. Open a PR (standard GitHub CLI — outside operator API)
PR_NUMBER=$(gh pr create --title "feat: my change" --body "Opened by my-agent." --base main | grep -oP '(?<=/pull/)\d+')

# 5. Claim/link the work item while working
curl -s -X POST $BASE/api/v1/work/items/$ID/claims \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"lastCommand":"/implement"}'

curl -s -X POST $BASE/api/v1/work/items/$ID/pr \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"branch\":\"feat/my-change\",\"prNumber\":$PR_NUMBER}"

# 6. Wait for CI to pass, then request a candidate-a flight
curl -s -X POST $BASE/api/v1/vcs/flight \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"prNumber\": $PR_NUMBER}"

# 7. Run /validate-candidate, then post its scorecard as a PR comment
```

| You want to…               | Use                           |
| -------------------------- | ----------------------------- |
| Open a PR                  | `gh pr create` (standard CLI) |
| Flight a PR to candidate-a | `POST /api/v1/vcs/flight`     |
| Monitor flight + merge     | `pr-manager` graph            |
| Review code quality        | `pr-review` graph             |
| Ask about the repo         | `brain` graph                 |

---

## Prerequisites

**First time setup:**

```bash
scripts/bootstrap/bootstrap  # installs Node, pnpm, OpenTofu, Docker + all project dependencies
```

## Database Setup

**First time after cloning:**

```bash
pnpm dev:infra              # Start postgres, litellm, etc.
pnpm db:setup               # Create dev database + run migrations
```

**For test database:**

```bash
pnpm db:setup:test          # Create test database + run migrations
```

**Quick Reference:**

- `pnpm db:migrate` - Run migrations on dev database
- `pnpm db:migrate:dev` - Same as above (explicit)
- `pnpm db:migrate:test` - Run migrations on test database
- `pnpm db:generate` - Generate new migration from schema changes

## Workflow

1. **Fork** the repo (default branch is `main` — that's correct).

2. **Clone and set upstream:**

   ```bash
   git clone git@github.com:<your-username>/cogni-template.git
   cd cogni-template
   git remote add upstream git@github.com:Cogni-DAO/cogni.git
   ```

3. **Always branch from main using Conventional Commit types:**

   ```bash
   git checkout main
   git reset --hard upstream/main
   git checkout -b feat/ai-preview-health-checks
   # or: fix/litellm-config-bug, chore/ci-playwright-cache, docs/update-readme, etc.
   ```

4. **Run local checks before committing:**

   ```bash
   pnpm check
   ```

5. **Use Conventional Commits:** `feat:`, `fix:`, `docs:`, `chore:`

6. **Open PRs to main:**
   - Push: `git push origin feat/xyz`
   - Open PR: `your-fork:feat/xyz → Cogni-DAO/cogni:main`

7. All CI and AI gates must pass for auto-merge.

**Branch naming convention:**

- Use Conventional Commit types: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`
- Examples: `feat/ai-preview-health-checks`, `fix/litellm-config-bug`, `chore/ci-playwright-cache`

**See [CI/CD Pipeline Flow](https://cognidao.org/knowledge/operator-pipeline-contract) for branch model details.**

## Code Style

- Prettier and ESLint are authoritative — do not hand-tune formatting.
- Follow directory-specific conventions defined in each `AGENTS.md`.

## Issues

- Search existing issues before opening a new one.
- Bug reports should include:
  - Reproduction steps
  - Expected vs. actual behavior
  - Environment details (OS, Node version, etc.)

## Governance & Exceptions

- Normal contributions merge automatically after passing gates.
- If an AI review fails and you believe it should pass, use the proposal link to request a DAO vote.
- DAO proposals should reference the PR number and briefly explain why the exception benefits the project.

## Security

Do not disclose security vulnerabilities here.  
See `SECURITY.md` for private reporting instructions.

Thank you for helping grow the Cogni ecosystem responsibly.
