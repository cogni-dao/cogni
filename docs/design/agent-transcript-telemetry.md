---
id: agent-transcript-telemetry
type: design
title: "Agent Transcript Telemetry — capture AI-developer sessions to Postgres, distill to the Dolt hub"
status: draft
spec_refs:
  - knowledge-syntropy
created: 2026-06-01
---

# Agent Transcript Telemetry

> Capture every AI-developer Claude Code session that contributes to a Cogni node,
> land the raw transcript in operator Postgres, and let a downstream harvester
> distill durable handoffs/takeaways into the Dolt knowledge hub — automatically,
> without a human asking agents to hand-write and paste them.

## Goal

Success is when **any agent's Claude Code session that touches a node repo lands
its transcript in operator Postgres keyed to the registered principal + head SHA,
and a harvester turns those transcripts into `contrib/*` knowledge contributions**
— the automated equivalent of a hand-written dev handoff.

## Two planes (the load-bearing decision)

```
RAW PLANE — Postgres (operational)         REFINED PLANE — Dolt hub (knowledge)
─────────────────────────────────         ────────────────────────────────────
agent_transcript_chunks               ──►   atomic takeaways / handoffs
• append-only firehose              harvester  • "use when X", cited, attributed
• secrets redacted client-side      (the ONLY  • RECALL → REFINE → CITE → WRITE
• RLS + TTL (disposable feedstock)   bridge)   • contrib/* branch, human-merge to main
```

`RAW_NEVER_ENTERS_HUB`: raw transcripts are never written to the Dolt hub. Only
synthesized, attributed, recallable atoms cross. The transcript is the entry's
`source_ref` provenance, not the entry.

## Why not the heartbeat handshake

`POST /api/v1/work/items/{id}/heartbeat` is **per-work-item and only fires during
an active claim** (30-min TTL). It cannot capture sessions that never claim an
item, so it is the wrong carrier for "all sessions". The checked-in Claude Code
`SessionEnd` hook covers every session with zero agent effort. Heartbeat-driven
*incremental* streaming (flush the transcript tail mid-session, cursor > 0) is the
productionization for long/never-cleanly-ended sessions — the schema's `(session_id,
cursor)` unique index already supports it.

## Phase 1 — Capture (this PR)

- `.claude/hooks/ship-transcript.mjs` — `SessionEnd` hook. Opt-in (`COGNI_KEY` gate),
  fire-and-forget, client-side secret redaction, 5s timeout, always exits 0.
- `POST /api/v1/telemetry/transcripts` — multipart ingest; binds `principal_id` from
  the authenticated token (never caller-supplied); idempotent on `(sessionId, cursor)`.
- `agent_transcript_chunks` (operator Postgres) — append-only, RLS+FORCE, FK to
  `users`, partial index on un-harvested rows for the harvester watermark.

## Phase 2 — Harvest (next PR)

A recurring operator-side job (Temporal schedule, mirroring `ScheduledSweepWorkflow`)
reads un-harvested transcripts, synthesizes a handoff-shaped entry, and writes it via
`knowledgeContributionService.create(...)` onto a `contrib/handoff-*` branch. On merge,
the existing DoltHub mirror publishes it. Marks rows `harvested_at`; raw rows TTL out —
the durable record lives as a recallable Dolt atom, the automated dev handoff.

## Invariants

- [ ] RAW_NEVER_ENTERS_HUB — only synthesized atoms reach Dolt; transcript = provenance.
- [ ] PRINCIPAL_DERIVES_SOURCE — `principal_id` bound from the token, never the request body.
- [ ] IDEMPOTENT_BY_SESSION_CURSOR — re-uploading the same chunk de-dups, never duplicates.
- [ ] ATTRIBUTION_TRACEABLE — every chunk + derived atom traces to its contributor.
