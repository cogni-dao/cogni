---
id: internship-candidate-pipeline-research
type: research
title: "Intern Candidate to Subsidized Contributor Pipeline"
status: draft
trust: draft
summary: "Revive the current /internship intake into a privacy-preserving, AI-assisted v0 pipeline: expanded interest form -> private applicant dossier -> Derek Calendly interview -> yes/no decision -> onboarding/subsidy follow-up."
read_when: "Designing applicant intake, internal AI triageing, interview scheduling, meeting capture, candidate knowledge dossiers, or intern subsidy payouts."
owner: derekg1729
created: 2026-05-31
updated: 2026-05-31
---

# Intern Candidate to Subsidized Contributor Pipeline

## TL;DR

`/internship` exists, but it is a dead intake today. The page collects `name`, `email`, `github`, `focus`, `squadStatus`, and `note`, then POSTs to `/api/v1/public/internship-interest`. The endpoint validates input, logs a non-PII event, returns a random `referenceId`, and persists nothing.

The fix is a pipeline, not another form:

1. Expand the form so it captures the five questions Derek would otherwise ask first.
2. Persist every applicant to a private dossier.
3. Create a non-PII public shadow work item.
4. Show or send Derek's Calendly link immediately unless the submission is obvious spam.
5. Use AI internally to summarize the form and prepare Derek; do not make applicants talk to an AI bot in v0.
6. Capture Derek's yes/no/hold decision after the interview.
7. Convert accepted applicants into contributors through `/contribute-to-cogni`.
8. Pay AI-subscription subsidy increments later, after DAO approval.

The top 0.1% version is not "buy an ATS and hope." Cogni should be the private system of record. Use best-in-class point tools only where they beat custom code: Cal.com for scheduling, Granola or Metaview for interview capture, Safe + Snapshot + Sablier for governance and payouts.

## As-Built Evidence

| Block                 | Path                                                                    | Current state                                                                      |
| --------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Public intake page    | `nodes/operator/app/src/app/(public)/internship/page.tsx`               | Live route `/internship`                                                           |
| Intake UI             | `nodes/operator/app/src/features/home/components/InternshipHome.tsx`    | Form posts JSON                                                                    |
| Intake API            | `nodes/operator/app/src/app/api/v1/public/internship-interest/route.ts` | Logs non-PII event, returns `referenceId`, no persistence                          |
| Intake contract       | `nodes/operator/app/src/contracts/internship.interest.v1.contract.ts`   | Zod op `internship.interest.v1`                                                    |
| Intake test           | `nodes/operator/app/tests/contract/app/internship-interest.test.ts`     | Asserts 201 path                                                                   |
| AI execution          | `POST /api/v1/chat/completions`                                         | OpenAI-compatible endpoint with optional `graph_name`; session-authenticated today |
| Work tracking         | `POST /api/v1/work/items`                                               | Server-allocated work item IDs                                                     |
| Private knowledge     | `POST /api/v1/knowledge/contributions`                                  | Reviewable Dolt branch contribution flow                                           |
| Durable orchestration | `packages/temporal-workflows/src/workflows/`                            | Existing Temporal workflow package                                                 |
| Schedules             | `POST /api/v1/schedules`                                                | Existing schedule API, no calendar integration                                     |

## Operating Principle

Derek should interview about 99% of real applicants. In v0, the "AI interview" is deliberately not a candidate-facing chat. The expanded form is the async interview; AI only compresses that form into a Derek prep brief and spam/context signal.

Expected human experience:

- Applicant fills the expanded interest form once.
- Applicant receives Derek's Calendly link unless spam, abuse, or obvious duplicate.
- Derek opens one dossier before the call and sees the applicant's context, GitHub signal, internal AI triage, and recommended questions.
- After the call, the recording/transcript summary is appended to the private dossier.
- Accepted applicants enter the contributor contract and subsidy flow.

## V0 Through-Line

The approved v0 is:

```text
expanded /internship form
  -> private dossier
  -> non-PII work item
  -> applicant sees Derek Calendly link
  -> Derek interview
  -> Derek decision: yes | no | hold
  -> accepted candidate gets contributor onboarding
```

No Discord. No candidate-facing AI chat. No automated calendar integration. No payout execution. The applicant-facing surface is just a better form plus Derek's Calendly link.

### Expanded Form Fields

Add these fields to the current `name/email/github/focus/squadStatus/note` payload:

| Field                | Purpose                                                    | Public?                                             |
| -------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| `timezone`           | Lets Derek schedule sanely                                 | private                                             |
| `weeklyAvailability` | Filters impossible schedules without rejecting good people | private summary only                                |
| `artifactUrl`        | Concrete work sample                                       | private, public work item stores only `hasArtifact` |
| `artifactNotes`      | Tells Derek what to inspect                                | private                                             |
| `whyCogni`           | Mission/context signal                                     | private summary only                                |
| `firstProjectChoice` | Routes conversation toward useful work                     | non-PII enum can be public                          |
| `reliableCommitment` | Candidate's explicit time/cadence promise                  | private summary only                                |
| `recordingConsent`   | Whether Derek can record/transcribe the call               | private                                             |

The submit success state should say:

1. "We received your application."
2. "Book a 30-minute Derek interview here: `<DEREK_CALENDLY_URL>`."
3. "Reference id: `<referenceId>`."

Spam control is intentionally crude in v0: rate limit, honeypot if needed, and obvious-spam suppression before showing the Calendly link. Do not add Discord or an AI-chat prefilter before the first real loop runs.

### Derek Decision

After the Calendly interview, Derek records one of:

| Decision | Effect                                                                          |
| -------- | ------------------------------------------------------------------------------- |
| `yes`    | Create contributor onboarding task and send `/contribute-to-cogni` instructions |
| `hold`   | Keep dossier open; add a follow-up note/date                                    |
| `no`     | Close candidate work item with non-PII reason category                          |

The decision form can be quick and dirty: a protected internal route, a work item label update, or a small script that appends to the dossier. It only needs to be auditable and PII-safe in logs.

## Recommended Tool Stack

| Layer                        | Recommendation                                      | Why                                                                                                                    |
| ---------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| System of record             | Cogni private applicant dossier + non-PII work item | Keeps PII private while making pipeline state visible to agents                                                        |
| Scheduling                   | Derek-owned Calendly link                           | Fastest v0 path; no calendar integration required                                                                      |
| Derek capture default        | Granola                                             | Botless desktop capture, no stored recordings per its security docs, strong for Derek's personal meeting memory        |
| Recruiting capture at volume | Metaview                                            | Purpose-built for recruiting conversations, structured interview notes, scorecard support, retrieval across interviews |
| Full ATS, if needed later    | Ashby                                               | AI Notetaker, scheduling, consent management, candidate opt-out, and ATS-native profile history                        |
| DAO custody                  | Safe on Base                                        | Standard multisig treasury with policy, roles, and transaction simulation                                              |
| DAO vote                     | Snapshot space                                      | Gasless/off-chain allocation votes for "seed intern AI-subsidy fund"                                                   |
| Subsidy payout v0            | Manual Safe USDC transfer                           | Lowest risk until at least two active interns complete the loop                                                        |
| Subsidy payout v1            | Sablier streams                                     | Purpose-built token streaming for payroll, grants, and vesting                                                         |

### Capture Decision

Use Granola when Derek is the only interviewer and needs private searchable memory. Use Metaview when recruiting workflow matters more than personal notes. Use Ashby only when Cogni needs a real ATS with consent management and scheduling primitives built in.

Do not make Read.ai, Fireflies, or a generic meeting bot the default for candidate interviews. Generic bots can work, but they increase candidate friction because the candidate sees a recording participant. If a bot is used, the calendar invite must disclose exactly what is recorded, how it is used, retention, and opt-out.

## Privacy Model

Applicant `name`, `email`, free-text notes, transcripts, and recordings are PII. They must not land in:

- Pino or Loki logs.
- Public work item titles or summaries.
- PR descriptions.
- Analytics events.
- Unredacted Langfuse traces.

PII home:

- v0: private knowledge contribution/dossier owned by `cogni_system`.
- v1: dedicated `applicants` table with RLS, plus dossier pointers.

Public shadow home:

- Work item type: `story`.
- Node: `operator`.
- Title: `Candidate <shortRef> - <focus>`.
- Labels: `applicant`, `intern-pipeline`, `stage:<stage>`.
- Summary: no name, no email, no transcript. Link only to private dossier id.

Consent rules:

- Human interview invite discloses whether recording/transcription is enabled.
- Candidate can opt out of recording without affecting candidacy.
- If candidate opts out, Derek can still use manual notes and append a non-recorded summary.

## Candidate State Machine

```text
applied
  -> dossier_created
  -> derek_calendly_offered
  -> derek_interview_booked
  -> derek_interview_complete
  -> accepted | held | closed
  -> contributor_onboarding
  -> subsidy_approved
  -> subsidy_paid
```

Only obvious spam should prevent the Calendly link in v0. The normal path is `derek_calendly_offered`.

## AI Workflows

### V0 Internal AI Graphs

Two small internal graphs are enough:

| Graph                   | Trigger                             | Input                                    | Output                                                                        | Why                                                           |
| ----------------------- | ----------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `intern-intake-triage`  | On form submit, or Derek digest run | Expanded form payload + reference id     | Spam flag, Derek prep summary, recommended questions, public redaction fields | Gives Derek context without making the applicant chat with AI |
| `intern-decision-brief` | After Derek interview               | Dossier + Derek notes/transcript summary | Decision draft: `yes/no/hold`, onboarding next step, subsidy eligibility note | Turns the call into an auditable decision and next action     |

These graphs can run inside the operator app using existing graph execution paths. They should write only structured outputs to the dossier and log only `referenceId`, stage, verdict, and request ids.

### VNext Candidate-Facing AI Interview

Candidate-facing AI interview is vNext, not v0. If added later, prefer one of:

| Channel               | Fit                                 | Reason                                                                             |
| --------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| Web form continuation | Best first candidate-facing AI path | Same origin, easiest consent/privacy story, no Discord identity coupling           |
| Email thread          | Acceptable                          | Low friction, slower turn-taking                                                   |
| Discord DM            | Avoid until community ops needs it  | Requires identity linking, bot moderation, channel privacy, and anti-spam controls |

## Temporal Workflow Shape

Full workflow: `CandidatePipelineWorkflow`.

Workflow input:

```ts
interface CandidatePipelineInput {
  referenceId: string;
  focus: "engineering" | "design" | "research" | "operations" | "unknown";
  source: "internship_form";
}
```

Activities:

| Activity                     | Output                           |
| ---------------------------- | -------------------------------- |
| `createApplicantDossier`     | Private dossier id               |
| `createCandidateWorkItem`    | Non-PII work item id             |
| `runIntakeTriageGraph`       | Derek prep brief                 |
| `showOrSendCalendlyLink`     | Link delivery marker             |
| `appendDossierEvent`         | Knowledge contribution commit id |
| `sendDerekDigest`            | Digest delivery receipt          |
| `awaitBooking`               | Booking id or timeout            |
| `appendMeetingCapture`       | Transcript/summary pointer       |
| `startContributorOnboarding` | Work item or contributor id      |
| `queueSubsidyPayment`        | Safe transaction draft id        |

Timers:

- 24h after application: nudge if Calendly not booked.
- 72h after application: include in Derek stale-applicant digest if no booking.
- 24h before Derek call: refresh dossier and generate prep questions.
- 2h after Derek call: ask Derek for decision if no scorecard exists.

Signals:

- `candidateBookedDerekInterview`.
- `meetingCaptureReady`.
- `derekDecisionSubmitted`.
- `subsidyTransactionExecuted`.

Do not build the full Temporal workflow before one manual loop succeeds. For v0, the only Temporal-shaped automation worth considering is a scheduled Derek digest. The rest can be durable HTTP actions plus idempotency keys.

## Dossier Schema

The private dossier should be append-only and readable by agents.

```ts
interface ApplicantDossierV0 {
  referenceId: string;
  createdAt: string;
  pii: {
    name: string;
    email: string;
  };
  publicSignals: {
    github?: string;
    focus: string;
    squadStatus: string;
  };
  timeline: Array<{
    at: string;
    type:
      | "application"
      | "intake_triage"
      | "booking"
      | "meeting_capture"
      | "derek_decision"
      | "subsidy";
    actor: "candidate" | "ai" | "derek" | "operator";
    summary: string;
    privatePayloadRef?: string;
  }>;
  currentStage: string;
  intakeTriage?: CandidateIntakeTriageV0;
}
```

AI intake triage output:

```ts
interface CandidateIntakeTriageV0 {
  verdict: "spam" | "refer" | "strong";
  scores: {
    missionFit: number;
    agency: number;
    technicalSignal: number;
    communication: number;
    reliability: number;
    trustSafety: number;
  };
  summary: string;
  recommendedDerekQuestions: string[];
  risks: string[];
  nextAction: "suppress_spam" | "show_calendly" | "fast_track_calendly";
}
```

## Expanded Form as Async Interview

The v0 form asks the interview warm-up questions directly:

1. What did you build or learn recently that made you want to work on Cogni?
2. Send one GitHub/research/design link and explain what Derek should look at.
3. Pick one: improve agent workflows, improve knowledge capture, improve DAO incentives, or improve infra. What would you try first?
4. What weekly availability can you reliably commit for the next month?
5. What should Derek know before spending 30 minutes with you?

Rubric:

- `spam`: empty, abusive, marketing blast, unrelated, fake links, or impossible availability.
- `refer`: real person, enough signal for a Calendly call.
- `strong`: clear builder energy, concrete artifact, good writing, relevant curiosity.

## Implementation Plan

### Crawl

1. Update `internship-interest` to persist a private dossier and create a non-PII work item.
2. Expand the form with artifact, availability, commitment, and consent fields.
3. Show Derek's Calendly link in the success state for every non-obvious-spam applicant.
4. Add `intern-intake-triage` as an internal graph or script that writes a Derek prep brief to the dossier.
5. Send Derek a daily digest of `refer` and `strong` applicants.
6. Use Granola for Derek's capture until volume proves Metaview or Ashby is worth the operational cost.

### Walk

1. Wrap the proven path in `CandidatePipelineWorkflow` only after manual v0 has run.
2. Add timer-based nudges and a Derek decision signal.
3. Add a consent-aware meeting capture attachment step.
4. Create a Safe on Base and Snapshot proposal to seed the subsidy fund.

### Run

1. Add Sablier streams for approved interns.
2. Connect contribution milestones to payout eligibility.
3. Graduate payout accounting into `proj.financial-ledger` and Merkle claims.

## Prototype

`scripts/experiments/intern-interview-screen.ts` is a PII-free experiment for the internal AI helper. Despite the historical filename, this is not a candidate-facing interview. It models expanded form answers -> Derek prep/triage -> dossier patch -> non-PII work item stub.

Dry run:

```bash
pnpm tsx scripts/experiments/intern-interview-screen.ts --dry-run
```

Live Cogni API run with session auth:

```bash
COGNI_SESSION_COOKIE='...' pnpm tsx scripts/experiments/intern-interview-screen.ts \
  --live \
  --base-url https://test.cognidao.org \
  --model gpt-5.4-mini
```

Validation note from 2026-05-31: the saved test bearer key receives `401 Session required` from `/api/v1/chat/completions`. Production automation should call the graph server-side from the operator app/Temporal worker, or add a dedicated bearer-capable intake-triage endpoint before using this route from an external agent.

The script intentionally avoids real names, emails, and transcripts. It writes no files unless `--output <path>` is provided.

## Open Decisions

1. Dossier store: knowledge contribution first, or schema-backed `applicants` table now.
2. Derek Calendly link: public on success for all non-obvious-spam submissions, or emailed after AI/Derek digest review.
3. Capture: Granola as Derek default, Metaview for recruiting volume, or Ashby if ATS is desired now.
4. Subsidy custody: fresh Safe on Base, or existing DAO treasury.
5. Identity bar: GitHub + wallet attestation for v0, or Gitcoin Passport/KYC.

## Validation Checklist

Candidate validation is two-layered:

1. **Pre-flight/local** proves the branch is internally coherent.
2. **Post-flight `/validate-candidate`** proves the same PR works on candidate-a, with human-axis UI/API exercise, agent-axis direct capability exercise, and Loki evidence from the validator's own requests.

### Flight Candidate Plan

1. Create or adopt one operator work item for the first shippable slice: `expanded internship form with private dossier, non-PII work item, and Derek Calendly handoff`.
2. Implement only the crawl slice:
   - `/internship` submit persists a private applicant dossier.
   - `/internship` submit creates a non-PII `story` work item.
   - Internal AI triage stores a Derek prep brief.
   - Success state offers Derek's Calendly link.
   - Derek digest can be manual or an internal route; do not build payouts yet.
3. Run local focused checks:
   - `pnpm test:contract -- internship-interest`
   - `pnpm tsx --tsconfig tsconfig.scripts.json scripts/experiments/intern-interview-screen.ts --dry-run`
   - `pnpm check:fast`
4. Push branch and open a draft PR.
5. Link PR to the work item through `/api/v1/work/items/$ID/pr`.
6. Wait for CI green.
7. Request flight through the operator API only: `POST /api/v1/vcs/flight { "prNumber": <N> }`.
8. Wait for `candidate-flight` success and confirm `https://test.cognidao.org/version` serves the PR head SHA.
9. Run `/validate-candidate <PR>` against candidate-a.
10. Only after scorecard is posted and green: mark ready for review.

### E2E Human/Agent I/O Matrix

| Surface                | Human input                                                                    | Human output                                                                  | Agent input                                                                               | Agent output                                                             | Loki proof                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `/internship` page     | Test applicant form with unique `referenceId` marker in non-PII-safe note text | Success state shows reference id and no client console errors                 | `POST /api/v1/public/internship-interest` with same payload                               | `201 { ok: true, referenceId }`                                          | `route="internship.interest"` and `event="internship.interest_submitted"` with `referenceId`, no raw name/email |
| Private dossier write  | n/a unless dossier UI exists                                                   | n/a                                                                           | Fetch dossier through internal/service path or knowledge contribution branch/diff         | Dossier contains name/email and application timeline event               | Dossier write event or contribution commit id tied to request id                                                |
| Non-PII work item      | Work page search by `referenceId` or short candidate id                        | Work item visible without name/email/note                                     | `GET /api/v1/work/items?text=<shortRef>`                                                  | One `story` item with labels `applicant`, `intern-pipeline`, stage label | `route="work.items.create"` or equivalent work item create log                                                  |
| Internal AI triage     | n/a unless private admin view exists                                           | Derek prep brief visible only in private view                                 | Run intake-triage endpoint/graph with PII-free form projection                            | Scorecard JSON: `verdict`, six scores, `nextAction`                      | Feature-specific graph/route log, not just generic chat traffic                                                 |
| Derek booking handoff  | Click booking link from confirmation/digest                                    | Calendly booking page opens with candidate ref, or success page contains link | n/a for v0 manual Calendly                                                                | n/a                                                                      | Link shown/sent log with reference id only                                                                      |
| Meeting capture attach | Derek marks consent and uploads/pastes summary                                 | Dossier timeline has `meeting_capture`; public work item still has no PII     | `POST` capture attachment route or service call                                           | `200`/`201` with private payload ref                                     | Capture attach log with `referenceId`, no transcript body                                                       |
| Accepted onboarding    | Derek sets decision `accepted`                                                 | Stage moves to `contributor_onboarding`                                       | `POST /api/v1/work/items` for contributor onboarding task, or `/contribute-to-cogni` flow | New contributor work item/id                                             | Work item create log tied to decision request                                                                   |
| Subsidy draft          | Derek confirms DAO-approved subsidy exists                                     | Safe transaction draft or manual "not eligible yet" state                     | Service call to draft payout only after accepted state                                    | `$200 USDC` draft id, or explicit blocked status                         | Payout draft log; never execute on validation unless using test-only funds                                      |

### `/validate-candidate` Procedure

1. Resolve PR:
   - `gh pr view <N> --json number,title,headRefOid,headRefName,files,statusCheckRollup`
2. Confirm `candidate-flight` is green for the PR head SHA.
3. Confirm build:
   - `curl -sf https://test.cognidao.org/version | jq .buildSha`
4. Load auth state:
   - `.local-auth/candidate-a-operator.storageState.json`
5. Human axis:
   - Use Playwright with captured auth when routes require session.
   - For public `/internship`, submit a unique test applicant.
   - Verify success UI and no console errors.
   - Search/inspect work item UI if the first slice exposes it.
6. Agent axis:
   - `POST /api/v1/public/internship-interest` with a unique test payload.
   - Query the private dossier path through the route/service added by the PR.
   - Query work items by candidate short ref.
   - Invoke intake-triage endpoint/graph directly; do not count graph listing as execution.
7. Observability:
   - Query Loki in the request window for route-specific markers.
   - Pass requires feature-specific logs tied to the validator's request id or reference id.
   - Confirm logs omit raw name, email, notes, transcript, and AI answer bodies.
8. Post the locked `/validate-candidate` scorecard to the PR.

### Scorecard Rows

Expected initial crawl-slice scorecard rows:

| PR TWEAK          | HUMAN                   | AI                              | LOKI                     | OVERALL   |
| ----------------- | ----------------------- | ------------------------------- | ------------------------ | --------- |
| INTERNSHIP INTAKE | Submit form             | Direct POST                     | Non-PII route log        | Must pass |
| PRIVATE DOSSIER   | Private view or n/a     | Direct read/diff                | Dossier write marker     | Must pass |
| WORK ITEM SHADOW  | Work UI search          | Work-item API read              | Work create marker       | Must pass |
| INTAKE TRIAGE     | Private UI or n/a       | Direct endpoint/graph execution | Triage completion marker | Must pass |
| CALENDLY HANDOFF  | Click Calendly link     | n/a                             | Link shown/sent marker   | Must pass |
| PRIVACY REDACTION | Inspect visible UI/logs | Inspect API/log payloads        | No PII in Loki           | Must pass |

### Test Data Contract

Use synthetic applicant data only:

```json
{
  "name": "Candidate Flight Test",
  "email": "candidate-flight+<sha>@example.com",
  "github": "https://github.com/example/issue-triage-agent",
  "focus": "engineering",
  "squadStatus": "solo",
  "note": "candidate-flight-ref:<sha-short>"
}
```

Expected invariant: this exact name and email may appear in the private dossier response only. They must not appear in Loki, public work item rows, PR comments, or knowledge entries intended for public review.

## Sources

- Granola security: https://www.granola.ai/security
- Metaview interview notes: https://www.metaview.ai/
- Metaview best practices: https://support.metaview.ai/account-management/privacy-and-security/ai-best-practices
- Ashby AI Notetaker: https://docs.ashbyhq.com/ai-notetaker
- Cal.com Routing Forms: https://cal.com/routing
- Cal.com routing API: https://cal.com/docs/api-reference/v2/orgs-routing-forms/get-organization-routing-forms
- Safe wallet: https://www.safe.global/
- Snapshot docs: https://docs.snapshot.box/spaces/create
- Sablier: https://sablier.com/
