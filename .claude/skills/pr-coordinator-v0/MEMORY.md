# pr-coordinator-v0 skill memory

## Response format (Derek preference)

Good flight-dispatched response = tight status box + 2 URLs (validation URL, PR URL; + GHA run URL only if long-running infra flight). Exemplar:

```
╔═══════════════════════════════════════════════════╗
║  PR Flight Coordinator v0                         ║
╠═══════════════════════════════════════════════════╣
║  Slot:         candidate-a        Lease: BUSY     ║
║  In flight:    PR #929 @ a595366                  ║
║  State:        QA window open                     ║
║  Rollout:      ✅ poly pod boot w/ matching SHA   ║
║  Flight run:   still in_progress (smoke step)     ║
╚═══════════════════════════════════════════════════╝

QA URL:   https://poly-test.cognidao.org/research
PR:       https://github.com/Cogni-DAO/node-template/pull/929
```

**Why:** Derek reads ≤2–3 lines per response. Status box + 2 URLs = complete, actionable, skimmable. More is noise.

**How to apply:** Every flight-dispatched post should fit that shape. If the response is LONGER, it must be because it completes the request (e.g. triage proposals, scorecard) — never both "flight dispatched" and "long recap".

## Grafana MCP is OPTIONAL when Derek explicitly asks to flight

**Override `SKILL.md`'s "grafana MCP must be loaded" hard-halt rule.** If Derek says "flight now" / "flight this" and grafana MCP is disconnected, proceed anyway. Proof-of-rollout via Loki becomes best-effort (check via gh run / SSH / direct endpoint if truly needed), not a gate.

**Why:** The hard-halt was being precious. Derek wants flights to happen; observability gaps are his problem to accept, not the coordinator's veto.

**How to apply:** Treat grafana MCP as "nice to have" for auto-QA. Missing MCP → note it, skip grafana-watcher sub-agent, rely on Derek QA alone. Never block a flight on MCP state.

## Be in charge — autonomous operation

Derek runs this loop in the background while working on other projects. He expects the coordinator to:

- **Pick the next PR without asking** when the queue is obvious (top ready PR, confirm only if the choice is genuinely ambiguous).
- **Rebase stale PRs** before flighting them if main has moved. Use `gh pr checkout` or manual rebase, push with `--force-with-lease` to the PR branch. Do NOT rebase draft PRs or other contributors' branches without a clear signal they want it.
- **Auto-flight → auto-score → auto-route** (merge on pass, review-request on fail) without mid-loop checkpoints.
- **Only interrupt Derek** for: hard blockers (conflict that needs human judgment, flight infrastructure broken, CI stuck), pass/fail scorecard deliveries, or ambiguous triage picks.

**Why:** Derek has limited attention. The coordinator's job is to keep the pipeline moving, not to ask permission at every step.

**How to apply:** Default to action. Narrate the plan in ≤3 lines, execute, report outcome. Confirm only when the choice is 50/50 or the action is destructive beyond a normal flight.

## NEVER claim a flight is healthy without proof-of-rollout. Dispatch ≠ rollout.

**This is the coordinator's ONE job.** Flight → *confirm the flight landed* → report. Skipping the confirm step is the single highest-impact failure mode.

What "dispatched" means: `gh workflow run` returned a run ID. Nothing is deployed yet.
What "rolled out" means: Argo reports Healthy AND the new pod emits `app started` with `buildSha` matching the PR head SHA in Loki.

**Explicit failure modes to guard against:**

1. **Lease-held dispatches silently fail.** If another flight is holding `candidate-lease.state`, a second dispatch completes instantly as `flight: failure` on the acquire step — NOT as a queued retry. Always `gh run view <id> --json conclusion` the dispatched run before reporting anything.
2. **User saying "healthy" means they checked the URL.** It does NOT mean your dispatched flight rolled out. If you have not verified buildSha in Loki AND the promote commit on `deploy/candidate-a` matches your PR head SHA, the user is probably seeing the *previous* deployment. Correct the user rather than agree.
3. **"PR Build succeeded" ≠ "flight will succeed".** PR Build produces images; candidate-flight needs the lease AND the ArgoCD sync AND a pod rollout. Three independent failure points after dispatch.

**Required confirm sequence after every dispatch:**

```bash
# 1. Wait for flight job to reach a terminal state
gh run view <run_id> --json conclusion,jobs --jq '{flight: (.jobs[] | select(.name=="flight") | .conclusion), verify: (.jobs[] | select(.name=="verify-candidate") | .conclusion)}'

# 2. Confirm the promote commit
git fetch origin deploy/candidate-a --quiet
git log origin/deploy/candidate-a -1 --format='%s'   # should read: candidate-flight: pr-<N> <SHA>

# 3. Confirm app-started log with matching buildSha in Loki
mcp__grafana__query_loki_logs:
  {namespace="cogni-candidate-a", pod=~"<app>-node-app-.*"} | json | msg="app started" | buildSha="<PR head SHA>"
# startRfc3339 = dispatch time; endRfc3339 = now. If empty → rollout didn't happen. Do not claim healthy.
```

Only after (1) terminal success + (2) promote commit matches + (3) Loki log exists may you report the flight as rolled.

**Why this rule exists:** On 2026-04-19 the coordinator dispatched #910 rebased, dispatched #932 (failed on lease), agreed with Derek that "#910 is healthy" without verifying, while candidate-a was actually still on #929 (the restore flight's lease was held). #910 was never tested on candidate. It then merged to main and broke preview. Every step above would have caught it.

**How to apply:** No exceptions, even when Derek is pushing hard. "Flighted and confirmed" is the required deliverable — "flighted" alone is a lie. If confirmation takes 3 minutes, take 3 minutes.
