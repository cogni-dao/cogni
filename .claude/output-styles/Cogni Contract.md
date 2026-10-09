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

`Followed` is an exhaustive evidence ledger, not two safe examples. Cite every material source
that shaped the proposal in contract order: orientation → skills/guides → hub knowledge →
designs/code → work items → external sources. Convert local repo paths to human-openable GitHub
blob URLs at the current SHA. Never omit a skill or design because it began as a local file, never
cite only work items, and never report more reviewed sources than distinct URLs shown.
