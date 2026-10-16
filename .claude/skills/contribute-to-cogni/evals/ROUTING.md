# Fresh-session prompts — run by Derek

Use a fresh agent for each. Full evals have not run.

1. "how does cognition get into a new agent session?"
2. "can you get this PR ready to merge?"
3. "what in our knowledge hub is stale or duplicated?"
4. "move docs/spec/knowledge-data-plane.md into the hub"
5. "thin database-expert and move its reference docs into the hub"

Inspect what the agent actually reads and does: research should stay research;
PR delivery should recall the delivery contracts; hub curation should recall the
knowledge contracts. Reading a skill being audited is legitimate research.
Do not supply router names or workflow instructions in the prompts. The named
skill in prompt 5 is the migration target, not a router hint.

For migration cases, inspect reads of the axioms and complete migration guides,
section-to-destination mapping, shell retention, reference repair, and the
merged-replacement gate before deleting any source. Static checks do not count
as these human-run agent evals.
