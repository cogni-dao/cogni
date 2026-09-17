# replay-2301 fixtures

Captured from the operator monorepo git history around PR #2301 (task.5132) — the hand-written
commit whose artifact set the env verb's ADD path must reproduce (story.5039, bug.5204):

- `pre/` — the tree BEFORE the commit: `git show 'f77d578dd74d791a14c658bb84de5fee30987190~1:<path>'`
- `expected/` — the tree AT the commit: `git show 'f77d578dd74d791a14c658bb84de5fee30987190:<path>'`

These fixtures pin behavior at #2301. Template changes (node-template overlays, the AppSet
template, the scheduler patch renderer) legitimately update `expected/` — regenerate both sides
from the new SHAs when that happens, and update the SHAs above.

Consumed by `../../replay-2301.spec.ts`, which drives `buildEnvDeltaPlan` (present:true) twice —
candidate-a over `pre/`, then preview over the composed output — and asserts the 9 rendered files
are byte-equal to `expected/` and the catalog is structurally equal (its hand-written comments are
out of byte scope).
