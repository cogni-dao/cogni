// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/vendor/assistant-ui/tool-ui-vcs-flight-candidate`
 * Purpose: Per-tool renderer for `core__vcs_flight_candidate` — narrates nodeRef dispatch with node/sourceSha/candidate-a chips.
 * Scope: Mounted by `ToolUIRegistry` inside the AssistantRuntime context. Pure presentation over the typed tool args/result.
 * Side-effects: none
 * Links: packages/ai-tools/src/tools/vcs-flight-candidate.ts (input/output schema)
 * @public
 */

"use client";

import {
  makeAssistantToolUI,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import {
  ToolCard,
  type ToolCardTone,
  ToolChip,
} from "@cogni/node-ui-kit/tool-card";
import {
  AlertTriangleIcon,
  CircleSlashIcon,
  Loader2Icon,
  RocketIcon,
} from "lucide-react";

const TOOL_NAME = "core__vcs_flight_candidate";
const CANDIDATE_A_VERSION_URL = "https://test.cognidao.org/version";

interface FlightArgs {
  readonly owner?: string;
  readonly repo?: string;
  readonly nodeSlug?: string;
  readonly sourceSha?: string;
  readonly workflowRef?: string;
}

interface FlightResult {
  readonly dispatched?: boolean;
  readonly nodeSlug?: string;
  readonly sourceSha?: string;
  readonly workflowUrl?: string;
  readonly message?: string;
}

const FlightView: ToolCallMessagePartComponent<FlightArgs, FlightResult> = ({
  args,
  result,
  status,
}) => {
  const owner = args?.owner ?? "Cogni-DAO";
  const repo = args?.repo ?? "cogni";
  const nodeSlug = result?.nodeSlug ?? args?.nodeSlug ?? null;
  const sha = result?.sourceSha ?? args?.sourceSha ?? null;
  const workflowRef = args?.workflowRef;

  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled";
  const hasError =
    status?.type === "incomplete" && status.reason !== "cancelled";
  const isRunning =
    status?.type === "running" || status?.type === "requires-action";
  const notDispatched =
    status?.type === "complete" && result?.dispatched === false;

  const Icon = isCancelled
    ? CircleSlashIcon
    : hasError || notDispatched
      ? AlertTriangleIcon
      : isRunning
        ? Loader2Icon
        : RocketIcon;
  const tone: ToolCardTone = isCancelled
    ? "muted"
    : hasError || notDispatched
      ? "danger"
      : isRunning
        ? "info"
        : "success";
  const iconClassName = isRunning ? "animate-spin" : undefined;

  const verb = isCancelled
    ? "Flight cancelled"
    : hasError
      ? "Flight failed"
      : notDispatched
        ? "Flight not dispatched"
        : isRunning
          ? "Flighting"
          : "Flighted";

  const shaHref =
    sha != null
      ? `https://github.com/${owner}/${repo}/commit/${sha}`
      : undefined;

  const title = (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <span className="font-medium">{verb}</span>
      {nodeSlug != null && <ToolChip>{nodeSlug}</ToolChip>}
      <span className="text-muted-foreground">to</span>
      <ToolChip mono href={CANDIDATE_A_VERSION_URL}>
        candidate-a
      </ToolChip>
      {sha && (
        <ToolChip mono href={shaHref} title={sha}>
          {sha.slice(0, 7)}
        </ToolChip>
      )}
      {workflowRef && workflowRef !== "main" && (
        <ToolChip mono title={`workflow ref: ${workflowRef}`}>
          via {workflowRef}
        </ToolChip>
      )}
    </span>
  );

  const errorText =
    hasError && status?.type === "incomplete" && status.error
      ? typeof status.error === "string"
        ? status.error
        : JSON.stringify(status.error)
      : null;

  const details = (
    <div className="flex flex-col gap-2 text-xs">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Repo</dt>
        <dd className="font-mono">
          {owner}/{repo}
        </dd>
        {nodeSlug != null && (
          <>
            <dt className="text-muted-foreground">Node</dt>
            <dd>{nodeSlug}</dd>
          </>
        )}
        {sha && (
          <>
            <dt className="text-muted-foreground">Source SHA</dt>
            <dd className="font-mono break-all">{sha}</dd>
          </>
        )}
        {workflowRef && (
          <>
            <dt className="text-muted-foreground">Workflow ref</dt>
            <dd className="font-mono">{workflowRef}</dd>
          </>
        )}
        {result?.dispatched != null && (
          <>
            <dt className="text-muted-foreground">Dispatched</dt>
            <dd>{result.dispatched ? "yes" : "no"}</dd>
          </>
        )}
      </dl>

      {result?.message && (
        <div className="text-foreground/80">{result.message}</div>
      )}

      {errorText && (
        <pre className="bg-danger/10 text-danger rounded p-2 font-mono break-all whitespace-pre-wrap">
          {errorText}
        </pre>
      )}

      <div className="border-border/60 text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 border-t border-dashed pt-2">
        {result?.workflowUrl && (
          <a
            href={result.workflowUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            View workflow run on GitHub →
          </a>
        )}
        <a
          href={CANDIDATE_A_VERSION_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
        >
          candidate-a /version ↗
        </a>
        <span>Verify candidate-a before promotion</span>
      </div>
    </div>
  );

  return (
    <ToolCard
      icon={Icon}
      iconClassName={iconClassName}
      tone={tone}
      title={title}
      details={details}
      defaultOpen={hasError || notDispatched}
    />
  );
};

export const VcsFlightCandidateToolUI = makeAssistantToolUI<
  FlightArgs,
  FlightResult
>({
  toolName: TOOL_NAME,
  render: FlightView,
});
