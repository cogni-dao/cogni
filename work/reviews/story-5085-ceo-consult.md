# story.5085 — plain-language consult (2026-10-14)

## What we've actually achieved

This morning one tenant (Poly) took the fleet down by hammering the shared database. Since then, three layers — only two are real yet:

1. **Design — done and durable.** The fix is structural, not clever throttling: big noisy nodes get their own database on their own machine; small nodes stay on the shared database behind enforced budgets; one honest health status that Grafana, the UI, and node developers all read. Independently reviewed, amended, merged into the hub, and generalized into the shared-substrate standard.
2. **Code — written and reviewed, not live.** PR #2730 is the **toolbox**: catalog fields, dedicated-cell provisioner, the lock-out-a-noisy-tenant switch, DSN cutover machinery. PR #2729 is the **operator of the toolbox**: the health status surface and the automatic containment controller. Both have exact-head APPROVEs and green CI after genuine find-and-fix cycles.
3. **Proof — zero.** Nothing has run live. Flights to candidate-a failed twice for a plumbing reason (the deploy system refuses a PR stacked on another PR). The only scorecard is an honest 🔴 FAIL. Production is still protected only by this morning's manual fences.

## Why "zero behavior change" for #2730

That's about HOW we ship, not what we're building. The new behavior (auto-containment, Poly's dedicated cell) switches on only through deliberate audited steps later. Merging the toolbox should change nothing for the six nodes running today — and since merging to main auto-deploys to preview, inertness must be proven, not assumed. Delivering a circuit breaker to the building must not flip anyone's lights; the rewiring is its own proven step. The real behavior change is proven on candidate-a — hostile replay fires, only the target is locked out, neighbors stay green, Poly's cell isolates — before anything promotes.

## The one decision

The stacked-PR flight limitation forces an ordering choice:

- **A (recommended):** validate and merge the toolbox PR alone, re-point #2729 at main, then run the full combined live proof before #2729 merges. Fast, standard practice; every real guarantee (replay, containment, 13 slots) still gates the merge and the promote.
- **B:** first build new deploy-system machinery to flight stacked PRs together. Preserves the original ordering ritual at the cost of building CI/CD plumbing under incident pressure.

Plus one standing click: merge the hub design refinement (inbox contrib-flock-leader-conductor-6b555902).

## Alignment

Verified against the north-star substrate model, fleet topology, incident evidence, the actual PR code, and Supabase/Neon/AWS practice. The one thing nobody can claim until a flight lands is live proof — which is exactly why nothing is called done.
