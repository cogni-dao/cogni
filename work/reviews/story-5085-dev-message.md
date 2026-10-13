# Copy/paste to the story.5085 developer

---

Independent design review of contrib-flock-leader-conductor-c3c279b0 is complete: **APPROVED, with five amendments already applied to your contribution** (commit seq 3, "Incorporate independent design review…"). Full review record: https://github.com/cogni-dao/cogni/blob/54717f0c6c/work/reviews/story-5085-noisy-neighbor-design.review.md. Nothing changed your core decision — the two-tier state substrate with host/process/volume isolation and sticky graduation matches Supabase/Neon/AWS-canon practice and the operator north star.

Re-read `noisy-neighbor-database-architecture` from the inbox (https://cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-c3c279b0) before implementing. What the amendments changed:

1. **Invariant scoped:** `CONTROL_PLANE_OUTSIDE_NODE_FAILURE_DOMAIN` → `CONTROL_PLANE_OUTSIDE_GRADUATED_NODE_FAILURE_DOMAIN`, with the residual risk stated plainly: control-plane persistence (operator Postgres, Temporal, Doltgres, Redis) still shares one VM/disk with the shared pool — the 2026-09-24 crash domain was non-Poly — and is the standing next graduation candidate.
2. **v1 critical actuator named:** the alert pages a human; fencing is the one audited operator action proven 2026-10-13 (revoke role logins, terminate sessions, source firewall fence); automating it belongs to task.5247. Thresholds alone are observation, not enforcement.
3. **Proof protocol gained step 5:** prove the _shared tier's_ warn/critical/fence policy with a bounded hostile workload under a throwaway shared-tier role on candidate-a. The dedicated-cell replay alone never exercises the policy the remaining pool lives on.
4. **Cutover sequencing:** no DSN-rotation path for substrate DB credentials exists today (materialization is create-if-absent; deploy-infra must never alter DB passwords). task.5246 delivers audited rotation through OpenBao/ESO _before_ any cutover step.
5. **New invariant `SPECS_FOLLOW_THE_DECISION`:** the task.5246 PR amends `docs/spec/databases.md` and `docs/spec/multi-node-tenancy.md` — the latter's "per-node databases on a shared server" non-goal now contradicts hub canon.

Also made explicit: admission bounds rate not query shape (graduation catches shape regressions); a new node replays at 2× its declared budget-profile design rate; the pooler omission is deliberate (I/O was the failure mode, not connections); state cells live on provider VMs, never Akash leases (gen 39→41 churn is the proof).

**Are you cleared to implement? Yes, conditionally:**

- The CEO-required design-review gate is satisfied. The hub contribution still needs the human merge click — treat the merged entries as canon, and do not begin data cutover before the merge lands.
- task.5246 and task.5247 may proceed now, honoring: (a) do not disturb the live Poly fences or the gen-41 candidate recovery owned by the incident session; (b) DSN rotation lands before cutover; (c) the spec amendments ride in the 5246 PR; (d) acceptance is the amended 7-step protocol — exact-SHA, two-region, all 13 catalog slots, including the new shared-tier policy step.

---
