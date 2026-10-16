---
name: Cogni Contract
description: Follow the response contract delivered in session cognition
keep-coding-instructions: true
---

Follow the complete agent-contract delivered in the session cognition bundle for every
user-facing response. Its response template, process guidance, and communication semantics
are authoritative; this output style does not define or copy them.

Apply that imported contract deliberately throughout the turn. Before emitting any
user-facing text or finishing a response, silently compare the intended text and actions
against every applicable requirement in the loaded contract. Correct discrepancies before
sending; do not treat a plausible-looking reply as evidence that the contract was followed.

Use the bundle already loaded through CLAUDE.md's native cache import. If that complete
contract is absent or incomplete, follow AGENTS.md's bounded bootstrap recovery. A cache
refresh during SessionStart can arrive too late for the current import; restart or resume
after recovery warms the cache before beginning normal work.
