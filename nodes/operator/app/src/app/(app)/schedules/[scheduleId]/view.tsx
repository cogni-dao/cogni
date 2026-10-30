// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/schedules/detail/view`
 * Purpose: Show owned schedule configuration and paged run history.
 * Scope: Owns node UI and query state; does not implement SQL or execution.
 * Invariants: Metadata pages are bounded; nullable locators remain unavailable.
 * Side-effects: IO
 * Links: https://cognidao.org/work/items/task.5356
 * @internal
 */
"use client";
import { presentScheduleRun } from "@cogni/scheduling/presentation";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components";
import { readSchedule, readScheduleRuns } from "../_api/readSchedule";
import { updateSchedule } from "../_api/updateSchedule";

export function ScheduleHistoryView({ scheduleId }: { scheduleId: string }) {
  const client = useQueryClient();
  const detail = useQuery({
    queryKey: ["schedule", scheduleId],
    queryFn: () => readSchedule(scheduleId),
  });
  const history = useInfiniteQuery({
    queryKey: ["schedule-runs", scheduleId],
    queryFn: ({ pageParam }) => readScheduleRuns(scheduleId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: detail.isSuccess,
    refetchInterval: 15_000,
  });
  const toggle = useMutation({
    mutationFn: updateSchedule,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["schedule", scheduleId] });
      void client.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
  const schedule = detail.data;
  const runs = history.data?.pages.flatMap((page) => page.runs) ?? [];
  if (!schedule)
    return (
      <div className="p-6">
        <Link href="/schedules" className="text-sm underline">
          All schedules
        </Link>
        <p role={detail.isError ? "alert" : "status"} className="my-4">
          {detail.error?.message ?? "Loading schedule…"}
        </p>
        {detail.isError && (
          <Button variant="outline" onClick={() => void detail.refetch()}>
            Try again
          </Button>
        )}
      </div>
    );
  const messages = Array.isArray(schedule.input.messages)
    ? schedule.input.messages
    : [];
  const prompt = messages
    .map((message) =>
      message && typeof message === "object" && "content" in message
        ? String(message.content)
        : ""
    )
    .filter(Boolean)
    .join("\n\n");
  return (
    <main className="mx-auto w-full min-w-0 max-w-5xl space-y-6 p-4 md:p-6">
      <Link
        href="/schedules"
        className="text-muted-foreground text-sm hover:underline"
      >
        ← All schedules
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-semibold text-2xl">
            {schedule.graphId.split(":").pop() ?? schedule.graphId}
          </h1>
          <p className="mt-2 text-muted-foreground text-sm">
            {schedule.cron} · {schedule.timezone}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge intent={schedule.enabled ? "default" : "secondary"}>
            {schedule.enabled ? "Active" : "Paused"}
          </Badge>
          <Button
            variant="outline"
            disabled={toggle.isPending}
            onClick={() =>
              toggle.mutate({
                id: scheduleId,
                data: { enabled: !schedule.enabled },
              })
            }
          >
            {toggle.isPending
              ? "Saving…"
              : schedule.enabled
                ? "Pause"
                : "Resume"}
          </Button>
        </div>
      </div>
      {toggle.isError && (
        <p role="alert" className="text-destructive text-sm">
          {toggle.error.message}
        </p>
      )}
      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer font-medium">Instructions</summary>
        <p className="mt-3 whitespace-pre-wrap break-words text-sm">
          {prompt || "No text instructions"}
        </p>
      </details>
      <section aria-label="Run history" className="min-w-0">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="font-semibold text-lg">Run history</h2>
          <Button
            variant="ghost"
            disabled={history.isFetching}
            onClick={() => void history.refetch()}
          >
            Refresh
          </Button>
        </div>
        {history.isError && (
          <div role="alert" className="mb-3 text-sm">
            <p>{history.error.message}</p>
            <Button variant="outline" onClick={() => void history.refetch()}>
              Try again
            </Button>
          </div>
        )}
        {history.isPending ? (
          <output>Loading history…</output>
        ) : !runs.length && !history.isError ? (
          <p className="py-8 text-center text-muted-foreground">No runs yet</p>
        ) : runs.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border">
            <Table className="min-w-lg">
              <TableHeader>
                <TableRow>
                  <TableHead>Scheduled time</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Conversation</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => {
                  const row = presentScheduleRun(run, {
                    timezone: schedule.timezone,
                  });
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap">
                        <time
                          dateTime={row.exactScheduledFor ?? undefined}
                          title={row.exactScheduledFor ?? undefined}
                        >
                          {row.timeLabel}
                        </time>
                      </TableCell>
                      <TableCell>{row.statusLabel}</TableCell>
                      <TableCell>{row.durationLabel}</TableCell>
                      <TableCell>
                        {row.conversationKey ? (
                          <Link
                            className="underline"
                            href={`/chat?thread=${encodeURIComponent(row.conversationKey)}`}
                          >
                            Open conversation
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">
                            Unavailable
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : null}
        {history.hasNextPage && (
          <Button
            className="mt-4"
            variant="outline"
            disabled={history.isFetching}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        )}
      </section>
    </main>
  );
}
