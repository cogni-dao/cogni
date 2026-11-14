// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/review/view`
 * Purpose: Single Finish Epoch workspace — open review, inspect/override, sign/finalize, publish, then claim.
 * Scope: Uses the all-epochs page read so review backlog, ended-open, and finalized settlement share
 *   one workspace. State remains visible to everyone; only mutations are authority-gated.
 * Invariants: ACTIONS_GATED_NOT_STATE, REVIEW_AUTHORITY_IS_EPOCH_PINNED, LATEST_MANIFEST_ONLY.
 * Side-effects: IO (review/open/finalize/publish hooks)
 * Links: src/features/governance/types.ts
 * @public
 */

"use client";

import {
  CheckCircle2,
  ExternalLink,
  FileSignature,
  Loader2,
  Lock,
  Pencil,
  Pin,
  RotateCcw,
  Save,
  X,
} from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Input,
  TableCell,
  TableRow,
} from "@/components";
import {
  receiptTitle,
  TYPE_ICONS,
  TYPE_LABELS,
} from "@/features/governance/components/ContributionRow";
import { EpochDetail } from "@/features/governance/components/EpochDetail";
import { EpochLifecycleProgress } from "@/features/governance/components/EpochLifecycleProgress";
import { EpochReviewAction } from "@/features/governance/components/EpochReviewAction";
import { ExecuteDistributionPanel } from "@/features/governance/components/ExecuteDistributionPanel";
import { SourceBadge } from "@/features/governance/components/SourceBadge";
import { useEpochsPage } from "@/features/governance/hooks/useEpochsPage";
import {
  useEpochReviewReadiness,
  useOpenEpochReview,
} from "@/features/governance/hooks/useOpenEpochReview";
import {
  type ReviewSubjectOverrideView,
  useReviewSubjectOverrides,
} from "@/features/governance/hooks/useReviewSubjectOverrides";
import { useSignEpoch } from "@/features/governance/hooks/useSignEpoch";
import { applyOverridesToEpochView } from "@/features/governance/lib/compose-epoch";
import {
  deriveEpochLifecycle,
  selectFinishEpoch,
} from "@/features/governance/lib/epoch-lifecycle-state";
import type {
  EpochContributor,
  EpochView,
  IngestionReceipt,
} from "@/features/governance/types";

interface ReviewViewProps {
  readonly nodeId: string;
  readonly walletAddress: string | null;
  readonly isCurrentApprover: boolean;
}

export function ReviewView({
  nodeId,
  walletAddress,
  isCurrentApprover,
}: ReviewViewProps): ReactElement {
  const { data, isLoading, error, refetch } = useEpochsPage();
  const handlePublished = useCallback(() => {
    void refetch();
  }, [refetch]);

  if (error) {
    return (
      <div className="rounded-lg border border-destructive bg-destructive/10 p-6">
        <h2 className="font-semibold text-destructive text-lg">
          Error loading review data
        </h2>
        <p className="text-muted-foreground text-sm">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-64 rounded-md bg-muted" />
        <div className="h-64 rounded-lg bg-muted" />
      </div>
    );
  }

  const reviews = data.allEpochs
    .filter((epoch) => epoch.status === "review")
    .sort((a, b) => Date.parse(a.periodEnd) - Date.parse(b.periodEnd));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="mb-1 font-bold text-3xl tracking-tight">Finish Epoch</h1>
        <p className="text-muted-foreground text-sm">
          One guided path from review through publication. Every state is
          visible; actions unlock only for the responsible wallet.
        </p>
      </div>

      <FinishEpochSelection
        nodeId={nodeId}
        walletAddress={walletAddress}
        isCurrentApprover={isCurrentApprover}
        epochs={data.allEpochs}
        evidence={data.distributionLifecycle}
        onPublished={handlePublished}
      />

      {reviews.length > 1 ? (
        <p className="text-muted-foreground text-sm">
          {reviews.length - 1} additional review epoch
          {reviews.length === 2 ? " is" : "s are"} queued behind this one.
        </p>
      ) : null}
    </div>
  );
}

function FinishEpochSelection({
  nodeId,
  walletAddress,
  isCurrentApprover,
  epochs,
  evidence,
  onPublished,
}: {
  readonly nodeId: string;
  readonly walletAddress: string | null;
  readonly isCurrentApprover: boolean;
  readonly epochs: readonly EpochView[];
  readonly evidence: Parameters<typeof deriveEpochLifecycle>[1];
  readonly onPublished: () => void;
}): ReactElement {
  const openEpoch = epochs.find((epoch) => epoch.status === "open") ?? null;
  const openReady = useEpochReviewReadiness(
    openEpoch?.status ?? "finalized",
    openEpoch?.periodEnd ?? ""
  );
  const selectionTime = openReady
    ? Date.parse(openEpoch?.periodEnd ?? "")
    : Number.NEGATIVE_INFINITY;
  const epoch = selectFinishEpoch(epochs, selectionTime);

  if (!epoch) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center">
        <p className="text-muted-foreground">No epochs yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5 rounded-xl border bg-card p-4 sm:p-6">
      <div>
        <h2 className="font-semibold text-xl">Epoch #{epoch.id}</h2>
        <p className="text-muted-foreground text-sm">
          {new Date(epoch.periodStart).toLocaleDateString()} —{" "}
          {new Date(epoch.periodEnd).toLocaleDateString()}
        </p>
      </div>
      <EpochLifecycleProgress epoch={epoch} evidence={evidence} />

      {epoch.status === "open" ? (
        <OpenEpochFinish
          epoch={epoch}
          isCurrentApprover={isCurrentApprover}
          reviewReady={openReady}
        />
      ) : epoch.status === "review" ? (
        <ReviewEpochSection epoch={epoch} walletAddress={walletAddress} />
      ) : (
        <FinalizedEpochFinish
          nodeId={nodeId}
          epoch={epoch}
          evidence={evidence}
          onPublished={onPublished}
        />
      )}
    </div>
  );
}

function OpenEpochFinish({
  epoch,
  isCurrentApprover,
  reviewReady,
}: {
  readonly epoch: EpochView;
  readonly isCurrentApprover: boolean;
  readonly reviewReady: boolean;
}): ReactElement {
  const openReview = useOpenEpochReview();
  return (
    <>
      <EpochDetail epoch={epoch} />
      {reviewReady ? (
        <EpochReviewAction
          status="open"
          reviewReady
          isApprover={isCurrentApprover}
          isPending={openReview.isPending}
          error={openReview.error}
          onOpen={() => openReview.mutate(epoch.id)}
          onContinue={() => undefined}
        />
      ) : (
        <Alert>
          <Lock className="h-4 w-4" />
          <AlertTitle>Collection is still open</AlertTitle>
          <AlertDescription>
            Review unlocks when this contribution window ends.
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}

// ── Per-epoch review section ─────────────────────────────────────────────────

function ReviewEpochSection({
  epoch,
  walletAddress,
}: {
  readonly epoch: EpochView;
  readonly walletAddress: string | null;
}): ReactElement {
  const { state, sign, reset } = useSignEpoch(epoch.id);
  const overrides = useReviewSubjectOverrides(epoch.id);
  const normalizedWallet = walletAddress?.toLowerCase() ?? null;
  const isPinnedApprover =
    normalizedWallet !== null &&
    (epoch.approvers?.some(
      (approver) => approver.toLowerCase() === normalizedWallet
    ) ??
      false);

  // Recompute contributor sums with overrides applied
  const adjustedEpoch = useMemo(
    () => applyOverridesToEpochView(epoch, overrides.overridesByRef),
    [epoch, overrides.overridesByRef]
  );

  const handleSign = useCallback(() => {
    void sign();
  }, [sign]);

  const renderExpandedRows = useCallback(
    (contributor: EpochContributor): ReactElement[] | null => {
      if (contributor.receipts.length === 0) return null;
      return contributor.receipts.map((receipt) => (
        <ReviewReceiptRow
          key={receipt.receiptId}
          receipt={receipt}
          override={overrides.overridesByRef.get(receipt.receiptId) ?? null}
          onSave={overrides.saveOverride}
          onRemove={overrides.removeOverride}
          isSaving={overrides.isSaving}
          canEdit={isPinnedApprover}
        />
      ));
    },
    [isPinnedApprover, overrides]
  );

  const activeOverrideCount = overrides.overridesByRef.size;

  const overrideSnapshotReady = !overrides.isLoading && !overrides.loadError;

  return (
    <div className="space-y-4">
      {activeOverrideCount > 0 && (
        <div className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm sm:flex-row sm:items-center">
          <Pencil className="h-3.5 w-3.5 text-warning" />
          <span className="text-warning">
            {activeOverrideCount} active weight{" "}
            {activeOverrideCount === 1 ? "override" : "overrides"}
          </span>
          <span className="text-muted-foreground">
            — expand contributions to view or edit
          </span>
        </div>
      )}

      {overrides.isLoading ? (
        <Alert role="status" aria-live="polite">
          <Loader2 className="h-4 w-4 animate-spin" />
          <AlertTitle>Loading the locked review snapshot</AlertTitle>
          <AlertDescription>
            Finalization stays unavailable until saved weight adjustments are
            loaded.
          </AlertDescription>
        </Alert>
      ) : overrides.loadError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Couldn&apos;t load saved weight adjustments</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              The visible totals may be incomplete, so signing is blocked. Retry
              the locked review snapshot before finalizing.
            </p>
            <Button
              variant="outline"
              className="min-h-11 w-full sm:w-auto"
              onClick={overrides.retryLoad}
            >
              Retry snapshot
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {overrides.mutationError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Weight adjustment was not saved</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              {overrides.mutationError.message} The row is unchanged; retry its
              Save or Reset action.
            </p>
            <Button
              variant="outline"
              className="min-h-11 w-full sm:w-auto"
              onClick={overrides.clearMutationError}
            >
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <EpochDetail
        epoch={adjustedEpoch}
        renderExpandedRows={renderExpandedRows}
      />

      {/* Sign & Finalize action */}
      <div
        className="flex flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-center"
        aria-live="polite"
      >
        {!overrideSnapshotReady ? (
          <div className="flex items-start gap-2 text-muted-foreground text-sm">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Sign and finalize unlocks after the review snapshot loads.
            </span>
          </div>
        ) : !isPinnedApprover ? (
          <div className="flex items-start gap-2 text-muted-foreground text-sm">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Review is visible, but only an approver pinned when this epoch
              closed can edit weights or sign and finalize.
            </span>
          </div>
        ) : state.phase === "IDLE" ? (
          <Button className="min-h-11 w-full sm:w-auto" onClick={handleSign}>
            <FileSignature className="mr-2 h-4 w-4" />
            Sign & Finalize
          </Button>
        ) : null}

        {overrideSnapshotReady && isPinnedApprover && state.isInFlight && (
          <Button className="min-h-11 w-full sm:w-auto" disabled>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {state.phase === "FETCHING_DATA" && "Preparing..."}
            {state.phase === "AWAITING_SIGNATURE" && "Awaiting wallet..."}
            {state.phase === "SUBMITTING" && "Submitting..."}
          </Button>
        )}

        {overrideSnapshotReady &&
          isPinnedApprover &&
          state.phase === "SUCCESS" && (
            <output className="flex items-start gap-2 text-sm text-success">
              <CheckCircle2 className="h-4 w-4" />
              <span>Epoch finalized (statement: {state.statementId})</span>
            </output>
          )}

        {overrideSnapshotReady &&
          isPinnedApprover &&
          state.phase === "ERROR" && (
            <div
              role="alert"
              className="flex flex-col gap-3 sm:flex-row sm:items-center"
            >
              <div className="break-words text-destructive text-sm">
                {state.errorMessage}
              </div>
              <Button
                variant="outline"
                className="min-h-11 w-full sm:w-auto"
                onClick={reset}
              >
                Try Again
              </Button>
            </div>
          )}

        {overrideSnapshotReady && isPinnedApprover ? (
          <p className="w-full text-muted-foreground text-xs">
            Verify the deployment environment shown in your wallet. This
            signature cannot be reused in another environment.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function FinalizedEpochFinish({
  nodeId,
  epoch,
  evidence,
  onPublished,
}: {
  readonly nodeId: string;
  readonly epoch: EpochView;
  readonly evidence: Parameters<typeof deriveEpochLifecycle>[1];
  readonly onPublished: () => void;
}): ReactElement {
  const lifecycle = deriveEpochLifecycle(epoch, evidence, true);

  return (
    <div className="space-y-4">
      <EpochDetail epoch={epoch} />
      {!lifecycle.isFolded ? (
        <Alert>
          <AlertTitle>Finalized without a distribution manifest</AlertTitle>
          <AlertDescription>
            The signed statement is final, but distributions were inactive or no
            wallet-resolved allocation could be folded. Nothing can be published
            from this epoch.
          </AlertDescription>
        </Alert>
      ) : lifecycle.isPublished ? (
        <Alert>
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>Claims are open</AlertTitle>
          <AlertDescription>
            This epoch is covered by the live cumulative root. Contributors can{" "}
            <Link href="/gov/holdings" className="underline">
              view their position and claim
            </Link>
            .
          </AlertDescription>
        </Alert>
      ) : evidence.publicationEvidence === "unknown" ? (
        <Alert>
          <AlertTitle>Publication status unknown</AlertTitle>
          <AlertDescription>
            The live root could not be reconciled with a persisted manifest.
            Publishing stays unavailable until chain evidence returns.
          </AlertDescription>
        </Alert>
      ) : lifecycle.isLatestFolded ? (
        <ExecuteDistributionPanel
          nodeId={nodeId}
          epochId={epoch.id}
          onPublished={onPublished}
        />
      ) : (
        <Alert>
          <Lock className="h-4 w-4" />
          <AlertTitle>Historical manifest locked</AlertTitle>
          <AlertDescription>
            A newer cumulative manifest supersedes this root. Only the latest
            folded epoch can be published.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// ── Receipt row with inline override editing ────────────────────────────────

function ReviewReceiptRow({
  receipt,
  override,
  onSave,
  onRemove,
  isSaving,
  canEdit,
}: {
  readonly receipt: IngestionReceipt;
  readonly override: ReviewSubjectOverrideView | null;
  readonly onSave: (
    subjectRef: string,
    overrideUnits: string,
    reason?: string
  ) => Promise<void>;
  readonly onRemove: (subjectRef: string) => Promise<void>;
  readonly isSaving: boolean;
  readonly canEdit: boolean;
}): ReactElement {
  const [isEditing, setIsEditing] = useState(false);
  const [editUnits, setEditUnits] = useState(override?.overrideUnits ?? "");
  const [editReason, setEditReason] = useState(override?.overrideReason ?? "");

  const handleStartEdit = useCallback(() => {
    setEditUnits(override?.overrideUnits ?? "");
    setEditReason(override?.overrideReason ?? "");
    setIsEditing(true);
  }, [override]);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
  }, []);

  const handleSave = useCallback(async () => {
    if (!editUnits.trim() || !/^\d+$/.test(editUnits.trim())) return;
    try {
      await onSave(
        receipt.receiptId,
        editUnits.trim(),
        editReason.trim() || undefined
      );
      setIsEditing(false);
    } catch {
      // Mutation error is surfaced via useReviewSubjectOverrides hook state
    }
  }, [receipt.receiptId, editUnits, editReason, onSave]);

  const handleRemove = useCallback(async () => {
    try {
      await onRemove(receipt.receiptId);
    } catch {
      // Mutation error is surfaced via useReviewSubjectOverrides hook state
    }
  }, [receipt.receiptId, onRemove]);

  const hasOverride = override !== null;
  const Icon = TYPE_ICONS[receipt.eventType] ?? Pin;
  const title = receiptTitle(receipt);
  const score = receipt.units;

  // Editing mode: use a colSpan row for the inline form
  if (isEditing && canEdit) {
    return (
      <TableRow className="bg-primary/5 hover:bg-primary/5">
        <TableCell colSpan={6} className="p-2">
          <div className="space-y-2">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <Icon className="h-3.5 w-3.5 text-muted-foreground" />
              <SourceBadge source={receipt.source as "github" | "discord"} />
              <span className="text-muted-foreground text-xs">
                {TYPE_LABELS[receipt.eventType] ?? receipt.eventType}
              </span>
              {title && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="truncate text-foreground/80 text-xs">
                    {title}
                  </span>
                </>
              )}
            </div>
            <div className="flex flex-col gap-2 pl-1 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <label
                  htmlFor={`override-units-${receipt.receiptId}`}
                  className="mb-1 block text-muted-foreground text-xs"
                >
                  Override weight (units)
                </label>
                <Input
                  id={`override-units-${receipt.receiptId}`}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={editUnits}
                  onChange={(e) => setEditUnits(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="e.g. 500"
                  className="min-h-11 text-sm"
                />
              </div>
              <div className="min-w-0 flex-2">
                <label
                  htmlFor={`override-reason-${receipt.receiptId}`}
                  className="mb-1 block text-muted-foreground text-xs"
                >
                  Reason (optional)
                </label>
                <Input
                  id={`override-reason-${receipt.receiptId}`}
                  type="text"
                  value={editReason}
                  onChange={(e) => setEditReason(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="e.g. trivial fix"
                  className="min-h-11 text-sm"
                />
              </div>
              <Button
                size="sm"
                className="min-h-11 w-full px-3 sm:w-auto"
                aria-label={`Save weight adjustment for ${title || receipt.receiptId}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleSave();
                }}
                disabled={
                  isSaving ||
                  !editUnits.trim() ||
                  !/^\d+$/.test(editUnits.trim())
                }
              >
                <Save className="mr-1 h-3 w-3" />
                Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="min-h-11 min-w-11 px-3"
                aria-label={`Cancel weight adjustment for ${title || receipt.receiptId}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleCancel();
                }}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </TableCell>
      </TableRow>
    );
  }

  return (
    <TableRow
      className={
        hasOverride
          ? "border-warning/20 bg-warning/5 hover:bg-warning/10"
          : "hover:bg-muted/20"
      }
    >
      {/* Chevron column — empty */}
      <TableCell className="w-8 px-2" />
      {/* # column — type icon */}
      <TableCell className="w-10 text-center">
        <Icon className="mx-auto h-3.5 w-3.5 text-muted-foreground" />
      </TableCell>
      {/* Contributor column — source + type + title + override badge */}
      <TableCell>
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <SourceBadge source={receipt.source as "github" | "discord"} />
          <span className="shrink-0 text-muted-foreground text-xs">
            {TYPE_LABELS[receipt.eventType] ?? receipt.eventType}
          </span>
          {title && (
            <>
              <span className="text-muted-foreground/40">·</span>
              {receipt.artifactUrl ? (
                <a
                  href={receipt.artifactUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex min-w-0 items-center gap-1 text-foreground/80 text-xs hover:text-foreground"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="truncate">{title}</span>
                  <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </a>
              ) : (
                <span className="truncate text-foreground/80 text-xs">
                  {title}
                </span>
              )}
            </>
          )}
          {hasOverride && override.overrideReason && (
            <Badge intent="secondary" size="sm" className="h-5 shrink-0 px-1.5">
              {override.overrideReason}
            </Badge>
          )}
        </div>
      </TableCell>
      {/* Share column — empty */}
      <TableCell className="text-right" />
      {/* Score column — includes edit/reset buttons */}
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-2">
          {score != null && hasOverride ? (
            <span className="font-mono text-xs">
              <span className="text-muted-foreground/50 line-through">
                {score}
              </span>
              <span className="text-muted-foreground/40">{" → "}</span>
              <span className="text-warning">{override.overrideUnits}</span>
            </span>
          ) : score != null ? (
            <span className="font-mono text-muted-foreground text-xs">
              {score}
            </span>
          ) : null}
          {canEdit ? (
            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="min-h-11 min-w-11 px-2"
                aria-label={`Adjust weight for ${title || receipt.receiptId}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleStartEdit();
                }}
                title="Adjust weight"
              >
                <Pencil className="h-3 w-3" />
              </Button>
              {hasOverride && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="min-h-11 min-w-11 px-2 text-muted-foreground hover:text-destructive"
                  aria-label={`Reset weight for ${title || receipt.receiptId} to original`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleRemove();
                  }}
                  disabled={isSaving}
                  title="Reset to original"
                >
                  <RotateCcw className="h-3 w-3" />
                </Button>
              )}
            </div>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}
