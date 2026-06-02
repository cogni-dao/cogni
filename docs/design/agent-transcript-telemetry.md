---
id: agent-transcript-telemetry
type: design
title: "Agent Transcript Telemetry — capture AI-developer sessions to Postgres, distill to the Dolt hub, view in Langfuse"
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

## Three planes (the load-bearing decision)

The raw corpus is the **source of truth**; the other two planes are derived views,
each serving a different consumer. Corpus + view is **both-and, not either-or** — a
prior design proposed replacing Postgres with Langfuse, which would have silently
dropped the verbatim corpus (a 2–11 MB transcript, capped to ~10 KB/turn in any
analytics backend can never re-derive a future-unknown metric). Resolved: keep the
corpus, add the view.

```
RAW PLANE — Postgres (corpus, SoT)     REFINED PLANE — Dolt hub (knowledge)
──────────────────────────────────    ─────────────────────────────────────
agent_transcript_chunks            ─►   atomic takeaways / handoffs (harvester)
• append-only firehose, verbatim        • "use when X", cited, attributed
• secrets redacted client-side          • RECALL → REFINE → CITE → WRITE
• RLS + FORCE + TTL (feedstock)         • contrib/* branch, human-merge to main
        │
        └─► ANALYTICAL PLANE — Langfuse (per-session view)
            • mapper: JSONL → session (trace/turn, generation, tool spans)
            • scrubbed + capped + source-tagged; live analytics + EVALS
            • CONSENT-GATED + OFF by default; never the store
```

`RAW_NEVER_ENTERS_HUB`: raw transcripts are never written to the Dolt hub. Only
synthesized, attributed, recallable atoms cross. The transcript is the entry's
`source_ref` provenance, not the entry. The Langfuse plane is likewise a derived
view — the corpus is canonical; Langfuse is lossy by design.

## Why not the heartbeat handshake

`POST /api/v1/work/items/{id}/heartbeat` is **per-work-item and only fires during
an active claim** (30-min TTL). It cannot capture sessions that never claim an
item, so it is the wrong carrier for "all sessions". The checked-in Claude Code
`SessionEnd` hook covers every session with zero agent effort. Heartbeat-driven
_incremental_ streaming (flush the transcript tail mid-session, cursor > 0) is the
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

## Phase 2b — Analytical view (Langfuse, additive)

A derived **view**, not a replacement for the corpus. On a fresh (non-deduped)
append, the route maps the same body into a Langfuse session and emits it
fire-and-forget — never blocking the ingest ack, never touching the corpus row.

- `@/shared/transcript/dev-session-map` — pure mapper: Claude Code JSONL → a
  backend-agnostic `DevSessionDraft` (one turn per user/assistant message, model +
  token usage, tool calls). Scrubs secrets and caps every author string before it
  enters the draft; tolerates the evolving JSONL shape (malformed lines dropped,
  never thrown). The mapper is the real, brittle work — covered by unit tests.
- `LangfusePort.recordDevSession` — emits one trace per turn grouped by
  `sessionId`, a generation per assistant turn, a span per tool, all tagged
  `source=claude-code-dev-session` so dev sessions never pollute operator-graph
  traces. Reuses the shared Langfuse keys held operator-side; devs never see them.
- **On by default, opt-out.** Langfuse is **Cloud** (`us.cloud.langfuse.com`).
  `TRANSCRIPT_LANGFUSE_EXPORT_ENABLED` defaults **true** — at MVP this is the
  operator's own dogfood, the same Langfuse instance already receiving graph traces,
  so the view is exercisable + `deploy_verified`-able. Set it `false` to opt out
  (a future production posture before external-dev egress consent is formalized).
  Content is always scrubbed + capped; the corpus pipeline runs unchanged. The route
  emits a `telemetry.transcripts.langfuse_export` log marker so the emit is
  Loki-provable without the destination project's read keys. Per-dev opt-in and a
  separate Langfuse project (quota isolation) are the next refinements.

## Invariants

- [ ] RAW_NEVER_ENTERS_HUB — only synthesized atoms reach Dolt; transcript = provenance.
- [ ] PRINCIPAL_DERIVES_SOURCE — `principal_id` bound from the token, never the request body.
- [ ] IDEMPOTENT_BY_SESSION_CURSOR — re-uploading the same chunk de-dups, never duplicates.
- [ ] ATTRIBUTION_TRACEABLE — every chunk + derived atom traces to its contributor.
- [ ] CORPUS_IS_SOURCE_OF_TRUTH — Langfuse is a derived, lossy view; the verbatim
      corpus (Postgres) is canonical and is never replaced by the analytics backend.
- [ ] VIEW_EGRESS_IS_OPT_OUT — Langfuse Cloud export is on by default (MVP dogfood),
      `TRANSCRIPT_LANGFUSE_EXPORT_ENABLED=false` opts out. Always scrubbed + capped.
- [ ] SOURCE_TAGGED — dev sessions tagged `source=claude-code-dev-session`.
