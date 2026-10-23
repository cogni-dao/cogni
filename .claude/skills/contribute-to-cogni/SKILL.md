---
name: contribute-to-cogni
description: Use when implementing a code change, opening a code PR, or resuming its CI, flight, merge, or promotion. Routes delivery to the current node's contracts. Routes each work-item status to its lifecycle command. Explanations and knowledge-only contributions use their task-specific guidance.
---

# Code delivery

Continue from the session cognition already loaded. This file routes code
delivery; it does not supply a second startup contract.

## Recall the current contracts

Read these entries through `GET /api/v1/knowledge/{id}` on the current node,
using its saved `COGNI_NODE_API_KEY`:

| entry                        | use it for                                                   |
| ---------------------------- | ------------------------------------------------------------ |
| `cicd-e2e-required-sequence` | access, CI, operator flight, merge, and promotion            |
| `validate-candidate`         | changed-surface exercise, exact SHA, and observability proof |

Use the session's node identity, candidate URL, approved outcome, and existing
work item. Reuse credentials; register only when no usable node credential exists.
Follow the session's bounded watch gates and local command budget. Verify stale
or draft guidance against the loaded contract and live API discovery before acting.

## Refresh guidance at the work-item interaction

Use `node scripts/agent/work-item-context.mjs` for `claim`, `update`,
`link-pr`, and read-only `next` when this adapter exists in the checkout.
Pass the explicit work-item id and `--node-url <this node origin>`; the client
uses this node's saved `COGNI_NODE_API_KEY`, never an operator deployment key.
It validates the live discovery contract before a write and returns the original
API result together with current work, coordination, and full owning guidance.
Read that result before taking the next dependent action.

Guides live at their owning hub. For shared shipping guidance on another hub,
pass `--guide-origin <owning origin> --guide-env-file <its private env file>`.
That file supplies the existing `COGNI_OPERATOR_NODE_API_KEY`, or the owning
hub's separate `COGNI_NODE_API_KEY` from its own env file. The client rejects
forwarding this node's key across origins. Reuse an existing reader identity.
Use `--env-file <this node's private env file>` when the process environment
belongs to another node. Missing sources or auth hold dependent work.

Use `--body '<JSON>'` for the existing mutation payload. Node-native `link-pr`
takes `{pr:<URL>,branch:<branch>}` and uses the advertised PATCH contract;
operator-session nodes retain their existing `/pr` payload. Where PATCH advertises
CAS, include `expectedRevision`. Where it does not, the result reports `cas:false`
and refuses to silently discard a supplied revision. Do not infer CAS from a read.

Call `next` before entering review, flight, validation, closeout or promotion,
and after every blocking CI/flight/deploy watcher, even without a status change.
Use `--guide <entry-id>` to load an additional owning hub skill in full when
required, such as `validate-candidate`. Read existing repository commands in full
on stage entry. A source receipt and a coarse status are not proof of completion.

If a mutation succeeded but guidance failed, retry **only `next`**. For an
unknown write outcome, reconcile the existing state/receipt before another write.
Raw API calls bypass automatic client guidance. SessionStart's cached projection
is advisory and requires a live `next` before dependent action. Run refreshes and
post-validation lifecycle updates outside the zero-artifact validator itself.

## Your stage is your work item's status

Run the one command for the status, then advance the status through the
work-item API. Do not skip a stage.

| status            | run                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------- |
| `needs_triage`    | `/triage`                                                                               |
| `needs_research`  | `/research`                                                                             |
| `needs_design`    | `/design`, then `/review-design` by a fresh agent                                       |
| `needs_implement` | `/implement`: test-first code, docs pass, open the PR                                   |
| `needs_merge`     | `/review-implementation` by a fresh agent while CI runs; both green → flight, validate  |
| `needs_closeout`  | `/closeout`: verify all gates at one SHA, operator merge, `done`, keep what was learned |

A story spanning several tasks belongs to `dev-manager`, which drives each task
through these stages.

Keep delivery authority with the operator. A GitHub developer grant may permit
branch pushes; it does not replace the operator merge gate. Follow the loaded
access instructions, including accepting a pending repository invitation.

## Knowledge is a separate reviewed lane

For knowledge-only work, use `contribute-knowledge-to-cogni` directly. During
code work, use it only when a durable finding earns a contribution; it owns
recall, refinement, citations, and the focused review inbox.

If the hub is unavailable, preserve the loaded cognition and committed floor.
Continue local work and targeted checks; verify remote delivery gates when their
authoritative sources are available. Never invent an endpoint or a passing verdict.
