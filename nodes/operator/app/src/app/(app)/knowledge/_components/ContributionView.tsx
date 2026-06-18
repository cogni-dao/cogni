// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/ContributionView`
 * Purpose: Full-page view of a single contribution — the permalink target for an
 *   inbox contribution. Renders metadata, shared diff, copy-link, and terminal
 *   merge / reject actions for open contributions.
 * Scope: Presentation. Fetches and mutates the record via React Query
 *   (cookie-session).
 * Side-effects: IO (GET /api/v1/knowledge/contributions/[id], POST merge/close).
 * @internal
 */

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components";
import { closeContribution } from "../_api/closeContribution";
import { fetchContribution } from "../_api/fetchContribution";
import { mergeContribution } from "../_api/mergeContribution";
import { ContributionActions } from "./ContributionActions";
import { ContributionDiff } from "./ContributionDiff";
import { CopyLinkButton } from "./CopyLinkButton";
import { RelativeTime } from "./RelativeTime";

export function ContributionView({ id }: { readonly id: string }) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["knowledge", "contribution", id],
    queryFn: () => fetchContribution(id),
    staleTime: 15_000,
    retry: false,
  });

  const invalidateContribution = () => {
    queryClient.invalidateQueries({ queryKey: ["knowledge"] });
    queryClient.invalidateQueries({
      queryKey: ["knowledge", "contribution", id],
    });
  };

  const mergeMutation = useMutation({
    mutationFn: (contributionId: string) => mergeContribution(contributionId),
    onMutate: () => setActionError(null),
    onSuccess: invalidateContribution,
    onError: (error) => setActionError(errorMessage(error)),
  });

  const closeMutation = useMutation({
    mutationFn: (vars: { contributionId: string; reason: string }) =>
      closeContribution(vars.contributionId, vars.reason),
    onMutate: () => setActionError(null),
    onSuccess: invalidateContribution,
    onError: (error) => setActionError(errorMessage(error)),
  });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-5 md:p-6">
      <Link
        href="/knowledge?mode=inbox"
        className="inline-flex w-fit items-center gap-1.5 text-muted-foreground text-xs hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Inbox
      </Link>

      {query.isLoading && (
        <p className="py-12 text-center text-muted-foreground text-sm">
          Loading contribution…
        </p>
      )}

      {query.error && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-6 py-16 text-center">
          <p className="font-medium text-sm">Contribution not found.</p>
          <p className="max-w-md text-muted-foreground text-xs leading-relaxed">
            No contribution with id <code className="font-mono">{id}</code>{" "}
            exists, or it isn't visible to you.
          </p>
        </div>
      )}

      {query.data && (
        <>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <span
                className="inline-flex rounded-md bg-muted px-1.5 py-0.5 font-medium uppercase tracking-wider"
                title={query.data.principalId}
              >
                {query.data.principalKind}
              </span>
              <span aria-hidden="true">·</span>
              <RelativeTime iso={query.data.createdAt} />
              <span aria-hidden="true">·</span>
              <span className="font-mono uppercase tracking-wider">
                {query.data.state}
              </span>
            </div>
            <h1 className="font-semibold text-xl leading-snug tracking-tight md:text-2xl">
              {query.data.message}
            </h1>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-muted-foreground text-xs">
                {query.data.contributionId}
              </span>
              <CopyLinkButton
                path={`/knowledge/inbox/${query.data.contributionId}`}
                label="Copy contribution link"
              />
            </div>
          </div>

          <ContributionActions
            item={query.data}
            busy={mergeMutation.isPending}
            rejectBusy={closeMutation.isPending}
            onMerge={(item) => mergeMutation.mutate(item.contributionId)}
            onReject={(item, reason) =>
              closeMutation.mutate({
                contributionId: item.contributionId,
                reason,
              })
            }
          />

          {actionError && (
            <Alert variant="destructive">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}

          <div className="mt-2 flex flex-col gap-1">
            <span className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
              Entries
            </span>
            <ContributionDiff contributionId={query.data.contributionId} />
          </div>
        </>
      )}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Contribution action failed.";
}
