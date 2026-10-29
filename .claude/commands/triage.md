Route AND score a work item against the node goals via the Cogni API. You route and rank; you do not create tasks, specs, or projects.

The full triage contract now lives in the operator hub. Read it, in order, with your saved COGNI key, before acting:

1. `GET https://cognidao.org/api/v1/knowledge/triage` — how to route a work item and score its six axes against the node goals.
2. `GET https://cognidao.org/api/v1/knowledge/work-item-scores-design` — the axes, the rank formula, and the evidence rule.
3. `GET https://cognidao.org/api/v1/knowledge/dao-goals-design` — priority is the node admin's, not yours.

Then triage the item below exactly as that contract says: read its current `revision`; score the six axes (an evidence URL at `v >= 4`, never the item's own page); apply ONE `PATCH` setting `scores` + `status` with `expectedRevision`; never set `priority`; route a `story` to its remaining-work status, never `done`.

If the hub is unavailable, keep the item at its current status and report the failed retrieval. Do not guess.

#$ITEM
