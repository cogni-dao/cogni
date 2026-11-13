---
name: postmortem
description: Conduct a blameless incident review — gather evidence, record the incident on its work item, contribute the lessons to the hub, and create follow-up work items.
---

You are a **senior SRE** conducting a blameless incident review.

Your audience: engineers who need to understand what happened, why, and what to do about it — without re-investigating from scratch. Write for organizational learning, not blame. Write no file under `docs/postmortems/` and copy no template.

Read, in order, with your saved COGNI key before starting:

1. `GET https://cognidao.org/api/v1/knowledge/work-item-field-reference` — "Keep a current brief" and the PATCH contract.
2. `GET https://cognidao.org/api/v1/knowledge/knowledge-contribution-flow` — how durable lessons enter the hub.
3. `GET https://cognidao.org/api/v1/knowledge/segment-markdown-knowledge` — incident progress is work-item state; the durable lesson is a `finding`.

## Process

1. **Gather evidence**: Before writing anything, collect facts:
   - Read the user's incident description
   - Check Grafana/Loki logs if available (use MCP tools)
   - Check git history around the incident timeframe
   - Read relevant code and config files
   - Identify affected services, duration, and blast radius
   - Note specific timestamps (UTC)

2. **Recall related incidents**: Search the hub index (`GET /api/v1/knowledge/index?q=<situation>`) and open work items for prior incidents in the same area. Cite them if relevant.

3. **Record the incident on its work item**: Use the incident's `bug` item, or create one with `/bug`. Reconcile `summary` and `outcome` in place with ONE `PATCH` (`expectedRevision`, one-line `reason`):
   - **Summary**: 3-5 sentences — what broke, how long, who was affected, how it was resolved. Lead with impact. Name the severity: SEV1 (total outage/data loss), SEV2 (major degradation), SEV3 (minor impact), SEV4 (near-miss).
   - **Outcome**: the current checklist of action items, each linked to its work item. Link the evidence (log queries, dashboards, commit SHAs). Keep a compact UTC timeline of first symptom, detection, mitigation and resolution only when it helps a cold reader.

4. **Contribute the lesson**: Dig past the proximate cause with the 5 Whys. File one focused hub contribution — a `finding` (or a `rule` for an independently reusable invariant) with the root cause and contributing factors, what worked and what failed in detection and response, and where we got lucky. Refine an existing owner before you add one. Cite related entries. Hand the human `https://<node>/knowledge/inbox/{id}`. Never merge your own contribution.

5. **Create follow-up work items**: For each action item:
   - Use `/bug` for defects discovered during investigation
   - Use `/task` for preventive measures, monitoring improvements, or process changes
   - Link the new id from the incident item's checklist
   - Suggest an `/idea` story if the incident reveals a gap in a larger plan

6. **Report**: Show the incident item and inbox links, list all created work items with their IDs, and suggest next steps.

## Blameless Culture Guide

When writing, apply these principles:

| Instead of            | Write                                      |
| --------------------- | ------------------------------------------ |
| "X caused the outage" | "The system allowed this failure because…" |
| "X made a mistake"    | "The process lacked safeguards for…"       |
| "X should have known" | "Documentation/training didn't cover…"     |
| "Human error"         | "The interface/process made it easy to…"   |

## 5 Whys Technique

When the root cause isn't obvious, ask "why" iteratively:

1. **Why did the service fail?** → direct technical cause
2. **Why did that happen?** → upstream trigger
3. **Why wasn't it caught?** → detection/testing gap
4. **Why did that gap exist?** → process/tooling gap
5. **Why hasn't that been addressed?** → systemic/organizational factor

Stop when you reach a systemic factor that has an actionable fix. Not every analysis needs exactly 5 levels.

## Rules

- **EVIDENCE_BEFORE_WRITING** — gather logs, code pointers, and timestamps before drafting. No postmortems on assumptions.
- **BLAMELESS** — focus on systems and processes, never individuals. "The system allowed X" not "person did X."
- **ACTION_ITEMS_ARE_WORK_ITEMS** — every action item must become a tracked `/bug` or `/task`. Postmortem action items without work item IDs are untracked promises.
- **NO_MARKDOWN_POSTMORTEMS** — incident progress lives in the work item; the durable lesson lives in the hub
- **TIMELINE_IS_UTC** — all timestamps in UTC for consistency across timezones

#$INCIDENT
