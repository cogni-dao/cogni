// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/experiments/intern-interview-screen`
 * Purpose: PII-free prototype for intern candidate AI intake triage and Derek prep dossier patch generation.
 * Scope: Runs a deterministic dry-run rubric, or optionally calls Cogni's OpenAI-compatible chat completions API. Does not persist applicant data.
 * Invariants: No applicant name/email/transcript is required; outputs only a reference id, rubric scores, dossier markdown, and non-PII work item stub.
 * Side-effects: IO (optional network call, optional output file)
 * Links: docs/research/internship-candidate-pipeline.md
 * @internal - experiment code, not for production use
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

type Verdict = "spam" | "refer" | "strong";
type NextAction = "suppress_spam" | "show_calendly" | "fast_track_calendly";

interface CandidateSignalInput {
  referenceId: string;
  focus: "engineering" | "design" | "research" | "operations" | "unknown";
  squadStatus: "solo" | "has_squad" | "forming_squad" | "unknown";
  github?: string;
  answers: InterviewAnswer[];
}

interface InterviewAnswer {
  questionId: string;
  question: string;
  answer: string;
}

interface RubricScores {
  missionFit: number;
  agency: number;
  technicalSignal: number;
  communication: number;
  reliability: number;
  trustSafety: number;
}

interface CandidateScreenScorecard {
  verdict: Verdict;
  scores: RubricScores;
  summary: string;
  recommendedDerekQuestions: string[];
  risks: string[];
  nextAction: NextAction;
}

interface PipelineArtifact {
  referenceId: string;
  generatedAt: string;
  scorecard: CandidateScreenScorecard;
  dossierMarkdown: string;
  knowledgeContributionDraft: {
    message: string;
    edits: Array<{
      op: "insert";
      entry: {
        id: string;
        domain: "meta";
        title: string;
        content: string;
        entryType: "scorecard";
        tags: string[];
      };
    }>;
  };
  workItemDraft: {
    type: "story";
    title: string;
    node: "operator";
    labels: string[];
    summary: string;
    outcome: string;
  };
}

interface CliOptions {
  dryRun: boolean;
  live: boolean;
  inputPath?: string;
  outputPath?: string;
  baseUrl: string;
  model: string;
  graphName?: string;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string | null;
    };
  }>;
}

const QUESTIONS: InterviewAnswer[] = [
  {
    questionId: "recent_build",
    question:
      "What did you build or learn recently that made you want to work on Cogni?",
    answer:
      "I built a small GitHub issue triage bot for my club. It labels issues, asks one follow-up question when requirements are vague, and posts a daily digest.",
  },
  {
    questionId: "artifact",
    question:
      "Send one GitHub/research/design link and explain what Derek should look at.",
    answer:
      "github.com/example/issue-triage-agent. Derek should look at the state machine in src/pipeline.ts and the tests around duplicate event handling.",
  },
  {
    questionId: "first_project",
    question:
      "Pick one: improve agent workflows, improve knowledge capture, improve DAO incentives, or improve infra. What would you try first?",
    answer:
      "Knowledge capture. I would turn applicant and contributor conversations into small private dossiers with explicit consent and a non-PII shadow item for agents.",
  },
  {
    questionId: "availability",
    question:
      "What weekly availability can you reliably commit for the next month?",
    answer:
      "8 to 10 hours weekly for four weeks. I can do two focused blocks and one async update every week.",
  },
  {
    questionId: "derek_context",
    question: "What should Derek know before spending 30 minutes with you?",
    answer:
      "I am early but reliable. I learn fastest when there is a concrete shipping loop and a human can tell me what was useful versus noisy.",
  },
];

const DEFAULT_INPUT: CandidateSignalInput = {
  referenceId: "candidate-demo-001",
  focus: "engineering",
  squadStatus: "solo",
  github: "github.com/example/issue-triage-agent",
  answers: QUESTIONS,
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: true,
    live: false,
    baseUrl: process.env.COGNI_BASE_URL ?? "https://test.cognidao.org",
    model: process.env.COGNI_MODEL ?? "gpt-5.4-mini",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
      options.live = false;
    } else if (arg === "--live") {
      options.live = true;
      options.dryRun = false;
    } else if (arg === "--input") {
      options.inputPath = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === "--output") {
      options.outputPath = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === "--base-url") {
      options.baseUrl = stripTrailingSlash(requireValue(argv, i, arg));
      i += 1;
    } else if (arg === "--model") {
      options.model = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === "--graph-name") {
      options.graphName = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function loadInput(path?: string): CandidateSignalInput {
  if (!path) return DEFAULT_INPUT;

  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return validateInput(parsed, path);
}

function validateInput(value: unknown, label: string): CandidateSignalInput {
  if (!isRecord(value)) throw new Error(`${label}: expected JSON object`);
  if (typeof value.referenceId !== "string" || value.referenceId.length < 3) {
    throw new Error(`${label}: referenceId is required`);
  }
  if (!isFocus(value.focus)) throw new Error(`${label}: invalid focus`);
  if (!isSquadStatus(value.squadStatus)) {
    throw new Error(`${label}: invalid squadStatus`);
  }
  if (value.github !== undefined && typeof value.github !== "string") {
    throw new Error(`${label}: github must be a string when present`);
  }
  if (!Array.isArray(value.answers) || value.answers.length === 0) {
    throw new Error(`${label}: answers must be a non-empty array`);
  }

  return {
    referenceId: value.referenceId,
    focus: value.focus,
    squadStatus: value.squadStatus,
    ...(value.github ? { github: value.github } : {}),
    answers: value.answers.map((answer, index) =>
      validateAnswer(answer, `${label}.answers[${index}]`)
    ),
  };
}

function validateAnswer(value: unknown, label: string): InterviewAnswer {
  if (!isRecord(value)) throw new Error(`${label}: expected object`);
  if (typeof value.questionId !== "string") {
    throw new Error(`${label}: questionId is required`);
  }
  if (typeof value.question !== "string") {
    throw new Error(`${label}: question is required`);
  }
  if (typeof value.answer !== "string") {
    throw new Error(`${label}: answer is required`);
  }
  return {
    questionId: value.questionId,
    question: value.question,
    answer: value.answer,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFocus(value: unknown): value is CandidateSignalInput["focus"] {
  return (
    value === "engineering" ||
    value === "design" ||
    value === "research" ||
    value === "operations" ||
    value === "unknown"
  );
}

function isSquadStatus(
  value: unknown
): value is CandidateSignalInput["squadStatus"] {
  return (
    value === "solo" ||
    value === "has_squad" ||
    value === "forming_squad" ||
    value === "unknown"
  );
}

function deterministicScreen(
  input: CandidateSignalInput
): CandidateScreenScorecard {
  const answerText = input.answers.map((answer) => answer.answer).join("\n");
  const normalized = answerText.toLowerCase();
  const totalAnswerChars = input.answers.reduce(
    (sum, answer) => sum + answer.answer.trim().length,
    0
  );

  const trustSafety = containsSpam(normalized) || totalAnswerChars < 80 ? 1 : 5;
  const technicalSignal = scoreBySignals(normalized, [
    "github",
    "test",
    "state",
    "src/",
    "pipeline",
    "built",
    "design",
    "research",
  ]);
  const missionFit = scoreBySignals(normalized, [
    "agent",
    "cogni",
    "dao",
    "knowledge",
    "contributor",
    "workflow",
  ]);
  const agency = scoreBySignals(normalized, [
    "i built",
    "i would",
    "try first",
    "shipping",
    "concrete",
    "reliable",
  ]);
  const communication =
    totalAnswerChars > 350 ? 5 : totalAnswerChars > 220 ? 4 : 3;
  const reliability =
    normalized.includes("hour") || normalized.includes("weekly") ? 5 : 3;

  const scores: RubricScores = {
    missionFit,
    agency,
    technicalSignal,
    communication,
    reliability,
    trustSafety,
  };
  const total = Object.values(scores).reduce((sum, score) => sum + score, 0);
  const verdict: Verdict =
    trustSafety <= 1 ? "spam" : total >= 27 ? "strong" : "refer";
  const nextAction: NextAction =
    verdict === "spam"
      ? "suppress_spam"
      : verdict === "strong"
        ? "fast_track_calendly"
        : "show_calendly";

  return {
    verdict,
    scores,
    summary:
      verdict === "spam"
        ? "Submission needs human spam review before any Calendly handoff."
        : "Real candidate signal. Send Derek booking link and brief him with the candidate artifact, availability, and first-project preference.",
    recommendedDerekQuestions: buildDerekQuestions(input, scores),
    risks: buildRisks(input, scores),
    nextAction,
  };
}

function scoreBySignals(text: string, signals: string[]): number {
  const hits = signals.filter((signal) => text.includes(signal)).length;
  return Math.min(5, Math.max(1, hits + 1));
}

function containsSpam(text: string): boolean {
  return [
    "buy followers",
    "seo backlinks",
    "casino",
    "guaranteed profit",
    "whatsapp only",
  ].some((signal) => text.includes(signal));
}

function buildDerekQuestions(
  input: CandidateSignalInput,
  scores: RubricScores
): string[] {
  const questions = [
    "What did you personally implement in the linked artifact, and what would you change after one more pass?",
    "What Cogni workflow should an intern make noticeably better in the first two weeks?",
  ];

  if (scores.reliability < 5) {
    questions.push(
      "What weekly cadence can you commit to without creating scheduling debt?"
    );
  }
  if (input.focus === "engineering") {
    questions.push(
      "Which boundary matters most here: API contract, private storage, Temporal workflow, or UI?"
    );
  }
  if (scores.missionFit < 4) {
    questions.push(
      "Why Cogni specifically, instead of a generic AI internship?"
    );
  }

  return questions.slice(0, 4);
}

function buildRisks(
  input: CandidateSignalInput,
  scores: RubricScores
): string[] {
  const risks: string[] = [];
  if (!input.github) risks.push("No GitHub or artifact link provided.");
  if (scores.technicalSignal < 3) risks.push("Technical signal is thin.");
  if (scores.reliability < 4) risks.push("Availability needs clarification.");
  if (scores.trustSafety < 3) risks.push("Spam or trust-safety review needed.");
  return risks.length > 0 ? risks : ["No blocking risk from intake triage."];
}

async function liveScreen(
  input: CandidateSignalInput,
  options: CliOptions
): Promise<CandidateScreenScorecard> {
  const apiKey = process.env.COGNI_API_KEY_TEST ?? process.env.COGNI_API_KEY;
  const sessionCookie = process.env.COGNI_SESSION_COOKIE;
  if (!apiKey && !sessionCookie) {
    throw new Error(
      "COGNI_SESSION_COOKIE, COGNI_API_KEY_TEST, or COGNI_API_KEY is required for --live"
    );
  }

  const response = await fetch(`${options.baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: {
      ...buildAuthHeaders({ apiKey, sessionCookie }),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      temperature: 0.1,
      max_completion_tokens: 900,
      response_format: { type: "json_object" },
      ...(options.graphName ? { graph_name: options.graphName } : {}),
      messages: [
        {
          role: "system",
          content:
            "You screen intern candidates for Cogni. Your job is to filter spam and prepare Derek for nearly every real applicant interview. Return strict JSON only.",
        },
        {
          role: "user",
          content: buildModelPrompt(input),
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401 && text.includes("Session required")) {
      throw new Error(
        "Cogni chat completions currently requires session auth on this route. Set COGNI_SESSION_COOKIE or add a server-side/bearer-capable intake-triage endpoint before using --live in automation."
      );
    }
    throw new Error(
      `Cogni chat completion failed (${response.status}): ${text}`
    );
  }

  const completion = (await response.json()) as ChatCompletionResponse;
  const content = completion.choices[0]?.message.content;
  if (!content) throw new Error("Cogni response did not include content");

  return parseScorecardJson(content);
}

function buildAuthHeaders(input: {
  apiKey?: string;
  sessionCookie?: string;
}): Record<string, string> {
  if (input.sessionCookie) return { Cookie: input.sessionCookie };
  if (input.apiKey) return { Authorization: `Bearer ${input.apiKey}` };
  return {};
}

function buildModelPrompt(input: CandidateSignalInput): string {
  return JSON.stringify(
    {
      task: "Score this PII-free intern expanded intake. Do not reject real applicants; only spam should be suppress_spam.",
      requiredJsonShape: {
        verdict: "spam | refer | strong",
        scores: {
          missionFit: "integer 1-5",
          agency: "integer 1-5",
          technicalSignal: "integer 1-5",
          communication: "integer 1-5",
          reliability: "integer 1-5",
          trustSafety: "integer 1-5",
        },
        summary: "one concise paragraph",
        recommendedDerekQuestions: ["question"],
        risks: ["risk"],
        nextAction: "suppress_spam | show_calendly | fast_track_calendly",
      },
      input,
    },
    null,
    2
  );
}

function parseScorecardJson(content: string): CandidateScreenScorecard {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed)) throw new Error("scorecard must be an object");

  const scores = isRecord(parsed.scores) ? parsed.scores : {};
  const scorecard: CandidateScreenScorecard = {
    verdict: parseVerdict(parsed.verdict),
    scores: {
      missionFit: parseScore(scores.missionFit, "missionFit"),
      agency: parseScore(scores.agency, "agency"),
      technicalSignal: parseScore(scores.technicalSignal, "technicalSignal"),
      communication: parseScore(scores.communication, "communication"),
      reliability: parseScore(scores.reliability, "reliability"),
      trustSafety: parseScore(scores.trustSafety, "trustSafety"),
    },
    summary: parseString(parsed.summary, "summary"),
    recommendedDerekQuestions: parseStringArray(
      parsed.recommendedDerekQuestions,
      "recommendedDerekQuestions"
    ),
    risks: parseStringArray(parsed.risks, "risks"),
    nextAction: parseNextAction(parsed.nextAction),
  };

  return scorecard;
}

function parseVerdict(value: unknown): Verdict {
  if (value === "spam" || value === "refer" || value === "strong") {
    return value;
  }
  throw new Error("invalid verdict");
}

function parseNextAction(value: unknown): NextAction {
  if (
    value === "suppress_spam" ||
    value === "show_calendly" ||
    value === "fast_track_calendly"
  ) {
    return value;
  }
  throw new Error("invalid nextAction");
}

function parseScore(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  if (value < 1 || value > 5) throw new Error(`${label} must be 1-5`);
  return value;
}

function parseString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const strings = value.map((item, index) =>
    parseString(item, `${label}[${index}]`)
  );
  return strings.length > 0 ? strings : ["None."];
}

function buildArtifact(
  input: CandidateSignalInput,
  scorecard: CandidateScreenScorecard
): PipelineArtifact {
  const generatedAt = new Date().toISOString();
  const dossierMarkdown = buildDossierMarkdown(input, scorecard, generatedAt);
  const entryId = normalizeKnowledgeId(input.referenceId);

  return {
    referenceId: input.referenceId,
    generatedAt,
    scorecard,
    dossierMarkdown,
    knowledgeContributionDraft: {
      message: `Add private intake triage ${input.referenceId}`,
      edits: [
        {
          op: "insert",
          entry: {
            id: entryId,
            domain: "meta",
            title: `Private intake triage ${input.referenceId}`,
            content: dossierMarkdown,
            entryType: "scorecard",
            tags: ["intern-pipeline", "intake-triage", input.focus],
          },
        },
      ],
    },
    workItemDraft: {
      type: "story",
      title: `Candidate ${shortRef(input.referenceId)} - ${input.focus}`,
      node: "operator",
      labels: [
        "applicant",
        "intern-pipeline",
        `stage:${scorecard.nextAction}`,
        `verdict:${scorecard.verdict}`,
      ],
      summary:
        "Non-PII candidate shadow item. Private dossier contains application details and AI intake triage.",
      outcome:
        scorecard.nextAction === "suppress_spam"
          ? "Human confirms spam or reopens for Derek interview."
          : "Derek interview completed and decision appended to private dossier.",
    },
  };
}

function buildDossierMarkdown(
  input: CandidateSignalInput,
  scorecard: CandidateScreenScorecard,
  generatedAt: string
): string {
  const answerLines = input.answers
    .map((answer) => `- ${answer.questionId}: ${compact(answer.answer, 220)}`)
    .join("\n");
  const scoreLines = Object.entries(scorecard.scores)
    .map(([key, value]) => `- ${key}: ${value}/5`)
    .join("\n");

  return [
    `# Candidate intake triage ${input.referenceId}`,
    "",
    `Generated: ${generatedAt}`,
    `Focus: ${input.focus}`,
    `Squad status: ${input.squadStatus}`,
    `GitHub/artifact: ${input.github ?? "not provided"}`,
    "",
    "## Verdict",
    "",
    `Verdict: ${scorecard.verdict}`,
    `Next action: ${scorecard.nextAction}`,
    "",
    scorecard.summary,
    "",
    "## Scores",
    "",
    scoreLines,
    "",
    "## Derek Questions",
    "",
    scorecard.recommendedDerekQuestions
      .map((question) => `- ${question}`)
      .join("\n"),
    "",
    "## Risks",
    "",
    scorecard.risks.map((risk) => `- ${risk}`).join("\n"),
    "",
    "## Expanded Form Evidence",
    "",
    answerLines,
  ].join("\n");
}

function normalizeKnowledgeId(referenceId: string): string {
  const normalized = referenceId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const parts = normalized.split("-").filter(Boolean).slice(0, 3);
  return ["candidate", ...parts].join("-");
}

function shortRef(referenceId: string): string {
  return referenceId.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || "unknown";
}

function compact(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars - 3)}...`
    : normalized;
}

function printUsage(): void {
  const name = basename(process.argv[1] ?? "intern-interview-screen.ts");
  console.log(`Usage: pnpm tsx scripts/experiments/${name} [options]

Options:
  --dry-run                 Run deterministic local rubric (default)
  --live                    Call Cogni chat completions
  --input <path>            Read PII-free CandidateSignalInput JSON
  --output <path>           Write PipelineArtifact JSON
  --base-url <url>          Cogni base URL (default: https://test.cognidao.org)
  --model <id>              Model for --live (default: gpt-5.4-mini)
  --graph-name <name>       Optional Cogni graph_name extension

Environment for --live:
  COGNI_SESSION_COOKIE       Preferred today; chat completions is session-authenticated
  COGNI_API_KEY_TEST         Useful once bearer auth is enabled for the target route
`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const input = loadInput(options.inputPath);
  const scorecard = options.live
    ? await liveScreen(input, options)
    : deterministicScreen(input);
  const artifact = buildArtifact(input, scorecard);
  const json = `${JSON.stringify(artifact, null, 2)}\n`;

  if (options.outputPath) {
    writeFileSync(options.outputPath, json, "utf8");
    console.log(`wrote ${options.outputPath}`);
    return;
  }

  console.log(json);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`intern-interview-screen failed: ${message}`);
  process.exitCode = 1;
});
