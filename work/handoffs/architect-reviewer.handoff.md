# HANDOFF — architect reviewer seat

## Your job

Review dev1 and dev2 against the north stars. You do not write code. You keep
them aligned, catch collisions, and stop unchecked assumptions before they cost
a night.

## How to talk to Derek — this is the job, not a preference

- **≤5 lines. 3rd-grade reading level. No jargon.** He is AFK 99% of the time.
- **Lead with the one thing that needs him.** If nothing does, say "nothing needs you."
- **Never bury a risk in a list.** If two agents are about to spend money, that is
  line one, not point three. He will not parse a wall.
- **Every status carries links** (PR, run, URL). Without them he assumes you stalled.
- **Report against the goal, not merges.** 107 commits landed in one night and the
  score never moved. Merges are not progress.
- He asks for copy/paste messages to the devs. Write them tight and complete.

## The only score

```
curl https://poly-test.cognidao.org/version
curl https://poly-preview.cognidao.org/version
```

Both dead. 6/6 nodes serve production; **0/6 have ever minted a non-production env.**
Derek needs BOTH — test is his warzone, preview runs paper trading long enough to
judge an algorithm. Production-only is not a partial win.

## Read before reviewing anything — do not re-derive

| entry (Dolt, node `operator`) | what it rules |
| --- | --- |
| `akash-actuator-wallet-cutover` | who pays (NS1–4) + the acceptance bar. The governing doc. |
| `akash-cicd-pareto-scope` | V0 scope + the as-built parity gap table |
| `unexecuted-lane-untested` | why a merged-and-green lane is untested |
| `lane-is-not-control` | the bug of the night, 4 sites (unmerged contribution) |
| `operator-node-catalog` | the roster is LIVE STATE — never hardcode it |

`GET /api/v1/knowledge/{id}` with the node key in `.env.cogni`.

**Read them before citing them.** The previous reviewer quoted these by name
without reading, and Derek caught it. They are correct and they already answer
most questions worth asking.

## The two lanes

| | dev1 | dev2 |
| --- | --- | --- |
| item | task.5132 | story.5039 |
| owns | poly mint: workflows, `infra/catalog/*`, Argo, shell | operator TypeScript env-verb path only |
| goal | get poly's first non-prod lease to serve | make the verb emit #2301 without hand edits |

Split is clean — no file overlap by construction.

**Awareness is ONE-WAY.** dev2 knows about dev1; dev1 does not know dev2 exists.
`owner` is **unset on every work item and is not settable through the API**, so
nothing in the tooling will ever warn either of them. Coordinate by posting lane
+ PR numbers into each item's `summary`. That is the only channel that persists.

## Live risks — check these first, every time

1. **Both lanes mint real paid leases.** dev1 on poly, dev2's acceptance run on
   toks4, in the same window, with no shared view. `present:false` does **not**
   close a lease yet (that is dev2's PR-B), so activation is a one-way door today.
   Break-glass: `scripts/ops/recover-orphaned-akash-lease.sh`.
2. **dev2 believes the shell sweep is done. It is not.** #2305 swept the AppSet
   path; #2309 finds three more sites of the same bug in shell
   (`secret-materialize.sh:115`, `deploy-infra.sh:1430`, `provision-env-vm.sh:1455`)
   — all in dev1's lane, which dev2 will not look at and dev1 is not checking.
3. **OpenBao policy is the one part of substrate that is not GitOps.** It needs a
   human with the production root token and a manual dispatch. Creds are real and
   on the machine: `~/dev/cogni-template/.local/provision-creds/production/`
   (`production-openbao-init.json` → `root_token`; the README is the custody SSoT —
   the GH init artifact expired, 1-day retention). **Derek does not run things.**
   A step only he can execute is a blocked step.

## The open gates — these are the review mechanism

| PR | state | catches |
| --- | --- | --- |
| #2302 | green, unmerged | a declared env missing its artifacts |
| #2304 | RED by design | AppSet-path consumers keyed on the lane (9 → 0 = sweep done) |
| #2309 | RED by design | control identities keyed on the lane (3 → 0) |

Red-by-design is deliberate: green is an objective definition of done, replacing
"I grepped and think I got them all" — the assumption behind most of the night.

**A gate that enumerates beats anyone's grep.** Grep found 1 of 9, and 1 of 3.

## What to actually review for

- **The bug of the night, in one line: one value doing two jobs, failing silently.**
  Lane vs control env — four sites in 24h. Expect a fifth. Root cause is one secret
  store PER CLUSTER; where env is a *label* in one store, the class cannot exist.
- **Definition of done.** `/version` proves the app booted, not that the node works.
  Require `/readyz?deep=1` — it makes substrate failures fatal. A node can serve
  `/version` with no database.
- **Any "do not re-derive" list.** Every defect on 2026-09-16/17 was an unchecked
  assumption. A section telling the next agent not to check is inverting the lesson.
- **Autonomy.** Interrupt Derek only for the irreversible or outward-facing. A
  design choice with a ruling in Dolt is neither — decide, cite, proceed. A blocking
  question costs the whole AFK window.

## Mistakes the last reviewer made — do not repeat

- Cited Dolt docs without reading them.
- Reported merges as progress while the two URLs stayed dead.
- Misread a **401** (wrong key) as a permissions decision and sent Derek the wrong way.
  401 ≠ 403. Check which.
- Shipped half an invariant (#2302 asserts artifacts EXIST; it would never have caught
  a consumer reading the OLD path) and assumed coverage.
- Wrote prose while the score was zero. If the URLs are dead and you are drafting,
  you are stalled.

## Unpaid debt

Node devs have **no documented path to add a service/sidecar**. Verified absent from
Dolt and from node-template; the only copy is `docs/guides/create-service.md` §9 in
the operator repo, which node devs never clone — and poly's paper-trader is its
worked example. Right home is Dolt, served into every node session at boot.
