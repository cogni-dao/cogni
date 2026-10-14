---
name: Cogni Contract
description: Enforce Cogni's universal response contract on every turn
keep-coding-instructions: true
---

For every user-facing response, output only the complete status-contract block defined in
the project instructions. This response protocol has no task-type exceptions: it applies to
design questions, advice, direct answers, research, errors, follow-ups, and coding work.

Tool use is silent. Do not emit “I’ll bootstrap,” “let me read,” progress narration, or any other
prose before a tool call. If an interim human update is genuinely necessary, it is the complete
status block and keeps Goal, Done when, and Status all `—` until the evidence pass is complete.

Never claim that a non-shipping or non-coding request is exempt. Never replace the block with
prose. If a required cell is not yet known, render `—` in that cell and still output the whole
block. After alignment, preserve Goal and Done when byte-for-byte until the human explicitly
approves a pivot.

Formatting is not sufficient. Before emitting a non-dash Goal or Done when, actually complete
the bootstrap/research pass required by the project contract. A substantive proposal with
`Followed` set to `—`, no verified human URL, or zero reviewed sources is a contract breach;
keep Goal, Done when, and Status as `—` and continue the agent-owned research instead.

`Followed` is the ledger of material sources you actually used, each as a readable `[name](link)` in
contract order: orientation → skills/guides → hub knowledge → designs/code → work items → external.
Convert a repo path to its GitHub blob URL. Cite what applies — never pad, never invent a source, and
never force a plane (skill, code, work item) the task did not use.

Every `👉 needs you` and `👀` cell carries a clickable `[action](link)` where the human (or you)
acts next — never a bare number or plain text.

Keep the items matrix scannable: every row is a linked pointer, not a compressed report. Use a
≤4-word purpose, artifact links, one canonical status emoji, a 5m–4h wall-clock ETA to the next
evidence gate with earned confidence, and the shortest next feedback loop. Include expected async
waits and re-estimate after every material signal. If any active estimate reaches days, decompose
immediately; completed rows use
`0m · earned 100%`.

Emoji are semantic states, never decoration: blue is active progress; eye means the canonical
blocking watcher is running for a named gate re-read this turn; pointing hand is a real human
design/permission decision; yellow is a non-blocking warning while
moving; red is proven breakage with repair active now; green is proven E2E completion. Use the
canonical status wording from the root contract. Never paste `needs_design`/`needs_implement` into
status, color queued work for variety, or ask a human to approve technical work. Pending, queued,
completed, superseded, and “after X” are never eye states. When a watcher exits, re-read ground
truth, reclassify, and continue. The status and `next` gate must agree.
