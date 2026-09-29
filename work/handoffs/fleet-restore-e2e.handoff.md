---
id: "fleet-restore-e2e"
type: handoff
work_item_ids: ["bug.5302", "bug.5287", "bug.5293", "bug.5303", "task.5153"]
status: active
created: 2026-09-29
branch: main
author: perth-4d (fable5)
---

# Handoff: fleet restored post-depletion; e2e CI/CD proof in progress

## Mission state (2026-09-29 ~22:00Z)
North star per Derek: **multiple cycles of reliably green CI/CD for a node across test/preview/prod.** First full cycle PROVEN: poly flight→validate→promote shipped 0a9ae6dd to prod through the standard pipeline minutes after restore. beirut-db is running repeated operator+toks4 cycles (their assignment). kyoto-3b owns poly.

## What happened (read bug.5302 for full chain)
Akash Console account depleted → HTTP 402 → every Akash lease died one-by-one over ~24h (class-B "served-then-died" = insolvency, NOT providers/images/code). Derek re-funded. Restore = catalog lease_generation bumps (PR #2470 by beirut-db, #2474 by me) + promotes/flights + manual create-pending clears.

## Live state
- 11/13 lanes green at handoff; toks5-prod + toks4-preview minting (wedges cleared ~21:45Z; monitor `green-run v2` reports).
- Merged today: #2470, #2472 (legacy controller DELETED — Derek override, proof-cycles running), #2474. Open: **#2471** (story.5013 balance low-water alarm — actuator-side, tested; MERGE IT + get it to prod, it prevents the whole depletion class from being silent).

## Hard-won operational knowledge (do not re-derive)
1. **create-pending wedge (bug.5303)**: ANY failed/rolled-back actuator create leaves `crossplane.io/external-create-pending` on the Request → permanent "cannot determine creation result" wedge. Fix: verify the receipt is failed-no-handle in the ledger (or lease demonstrably closed/rolled back), then `kubectl annotate <request> crossplane.io/external-create-pending-`. Done ~8x. Automate post-task.5154.
2. **Workflow verify LIES RED during fleet restores**: verify windows < wallet-single-writer mint queue. `/version` is the only truth (standing discipline).
3. **402-disqualifies-strike rule**: any lease closure coincident with account-level 402 must never record a provider strike (recorded on task.5153; task.5154 = corroboration before `onGiveUp: Replace` arms).
4. **zsh traps in this harness**: unquoted `$VAR` command strings and `for x in $LIST` do NOT word-split; `set -- $pair` doesn't split; pkill patterns self-match ssh wrappers (use `[b]racket` trick).
5. **Catalog is the generation SSOT** — never bump deploy-branch manifests directly (my gen-5 expedient caused a two-writer drift, since reconciled).
6. **bug.5293** (pg exit-2 crash-loop): DORMANT 22h+, killer never named (invisible to pg_stat_activity = <2s/startup-phase backend). Harnesses still armed on prod VM: `/tmp/pgcatch/` sampler v3 (all backend types, 1s, crash-preserving) + `/tmp/pgcatch/pcap/` 5432 handshake ring. If crashes return under restored load: harvest caught/<ts>/, map PID→client via pcap. If quiet through full load: close as pressure-collateral. Pending Derek asks if needed: log_connections toggle; auditd install.

## Queued dev work (in arc order, beirut-db dev-manages)
1. task.5154 strike corroboration (arc critical path; beirut-db).
2. Widen `onGiveUp` enum → Replace, opt-in candidate-tier lane; MANUFACTURED wedge (deliberately close a scratch lease) = live bounded-recovery proof — the bug.5287 finish line.
3. `$heldClosed` status fix (mine, small): closed-lease XR with non-matching requestDetails key shows Progressing/None instead of LeaseClosed (composition status branch should key on $closed when not recovering).
4. bug.5303 evidence-gated auto-clear.
5. Closeouts: bug.5302 (after multi-cycle green), 5293, hub contributions (depletion taxonomy, 402-strike rule, verify-lies-red pattern).

## Standing red lines
Never force Argo sync on poly (orphan 36c965c3 = 13-commit rollback). Promotion via operator API only. Chain state > receipts > cost stream for lease liveness. toks5-preview wedge retired by Derek's all-green directive — proof vehicle is now "manufacture one."
