---
id: common-mistakes
type: guide
title: Common Agent Mistakes
status: active
trust: reviewed
summary: Top mistakes agents make and how to avoid them
read_when: Before implementing features, debugging failures, or reviewing code
owner: derekg1729
created: 2026-03-07
verified: 2026-03-07
tags: [agents, mistakes, troubleshooting]
---

# Common Agent Mistakes

## Architecture Violations

- Import `adapters` from `features` or `core` (layer boundary violation)
- Create files in wrong architectural layer
- Import `@langchain/*` from `src/**` (must be in `packages/langgraph-graphs/`)
- Import internal files instead of public entry points (`public.ts`, `index.ts`)

## Contract & Type Mistakes

- Create manual type definitions for contract shapes (use `z.infer`)
- Modify contracts without updating dependent routes/services
- Skip contract-first: always update `src/contracts/*.contract.ts` before touching routes
- Two PRs claim "parity" on a shared policy without a parity test that runs **identical fixtures** through **both** implementations. Parallel test suites that each pass independently prove only self-consistency, not agreement. See `tests/ci-invariants/single-node-scope-parity.spec.ts` for the pattern (shared JSON fixtures + reference classifier; both sides assert against the same expected outcomes).

## Tooling Misunderstandings

- Use `console.log` (use Pino server logger / clientLogger for browser)
- Running `pnpm check` after every small change — it takes 5-10 minutes. Run the specific suite for your change instead:

### Run the right test suite for your change

| What you changed           | Run this                               |
| -------------------------- | -------------------------------------- |
| TypeScript types / imports | `pnpm typecheck`                       |
| Lint / formatting          | `pnpm lint:fix && pnpm format`         |
| `src/` unit logic          | `pnpm test:unit`                       |
| Contract shapes            | `pnpm test:contract`                   |
| `packages/` code           | `pnpm test:packages:local`             |
| `services/` code           | `pnpm test:services:local`             |
| Architecture / imports     | `pnpm arch:check`                      |
| AGENTS.md / docs           | `pnpm check:docs`                      |
| Specific test file         | `pnpm vitest run path/to/file.test.ts` |

Run `pnpm check` as a final gate before commit — not after every edit.

**Do not run `pnpm check:full`** — it requires Docker and full stack infrastructure. Agents should use `pnpm check` only. CI handles the full validation.

### A `// codeql[...]` comment does NOT clear a red CodeQL check

Verified the hard way on alert #55 (PR #2224, 2026-09-14): the inline marker is **documentation, not suppression**. GitHub code scanning does not honour it here, and no amount of moving or reformatting the comment turns the check green.

**What actually clears it** is dismissing the alert in GitHub — Security → Code scanning → _Dismiss_ → "False positive", or:

```bash
gh api -X PATCH repos/cogni-dao/cogni/code-scanning/alerts/<N> \
  -f state=dismissed -f dismissed_reason='false positive' \
  -f dismissed_comment='<= 280 chars, says WHY'
```

**Put `dismissed_comment` in the SAME call that dismisses.** Three traps here, all hit on alert #55:

| trap                                 | what you get                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Comment > 280 chars                  | `422 Only 280 characters are allowed; N were supplied` — **and the dismissal does not happen either** |
| Dismiss first, add the comment after | `400 Alert is already dismissed` — the comment is **not amendable**                                   |
| Recovering from the above            | Only way back is `-f state=open`, then re-dismiss **with** the comment in one call                    |

So a first attempt that fails on length, followed by a retry without the comment, leaves a **dismissed alert with no recorded justification** — an artifact that reads as handled with the reasoning invisible. That is the same silently-handled shape this whole section is about, so check the alert with a fresh `GET` afterwards rather than trusting the write response.

That is how every prior instance of `js/insufficient-password-hash` in this repo was resolved (alerts #3, #7, #15, #30 on `accountId.ts`). The inline marker is still worth writing — it puts the reason next to the code so a reader does not have to open the Security tab — but **treat it as a comment, never as a gate-clearing mechanism.**

Two things that follow:

- **A red CodeQL check on your PR is a decision, not a formatting bug.** Dismissing an alert is a security judgement: write the justification down (docblock + PR comment), and only dismiss when the rule's threat model genuinely does not apply. `js/insufficient-password-hash`, for instance, targets _password storage_ — it does not bind on a truncated version tag over a high-entropy API key that never authenticates anything.
- **CodeQL only fails the check on alerts NEW to your PR.** A pre-existing alert elsewhere in the repo does not block you, which is why an old file can carry the same pattern with no red check — and why you should not conclude from that file that its inline comment is what is holding the line.

## Documentation Mistakes

- Restate root AGENTS.md policies in subdirectory files
- Add "none" sections that add no information
- Write AGENTS.md for behavior details (keep those in file headers)

## When Things Fail

### dependency-cruiser violations

Output format: `error  no-<rule-name>: <from-path> → <to-path>`

Fix: check the `may_import` in the source directory's AGENTS.md and `.dependency-cruiser.cjs`. Move the import to the correct layer.

### Lint / format errors

Run `pnpm lint:fix && pnpm format` to auto-fix most issues.

### Architecture test failures

Check `tests/arch/` — these validate layer boundaries. If a new import path is legitimate, update `.dependency-cruiser.cjs` and the relevant AGENTS.md boundaries.

### Type errors after contract changes

Update all consumers: `z.infer<typeof SomeContract>` will propagate the change. Search for the contract name to find all dependents.
