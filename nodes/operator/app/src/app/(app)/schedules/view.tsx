// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/schedules/view`
 * Purpose: Client-side view for Schedules CRUD console.
 * Scope: Manages schedule list, create form, toggle, and delete. Does not implement business logic.
 * Invariants: Uses React Query for data fetching and mutations
 * Side-effects: IO
 * Links: [fetchSchedules](./_api/fetchSchedules.ts), [createSchedule](./_api/createSchedule.ts)
 * @public
 */

"use client";

import type { ModelRef } from "@cogni/ai-core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import {
  Badge,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components";
import { ModelPicker } from "@/features/ai/components/ModelPicker";
import { useModels } from "@/features/ai/hooks/useModels";
import { createSchedule } from "./_api/createSchedule";
import { deleteSchedule } from "./_api/deleteSchedule";
import { fetchAgents } from "./_api/fetchAgents";
import { fetchSchedules } from "./_api/fetchSchedules";
import { updateSchedule } from "./_api/updateSchedule";

const SCHEDULE_PRESETS = [
  { label: "Every minute", value: "* * * * *" },
  { label: "Every 2 minutes", value: "*/2 * * * *" },
  { label: "Every 5 minutes", value: "*/5 * * * *" },
  { label: "Every 10 minutes", value: "*/10 * * * *" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Every 30 minutes", value: "*/30 * * * *" },
  { label: "Hourly", value: "0 * * * *" },
  { label: "Daily at 9:00 AM", value: "0 9 * * *" },
  { label: "Daily at 6:00 PM", value: "0 18 * * *" },
  { label: "Weekly (Monday 9 AM)", value: "0 9 * * 1" },
];

const TIMEZONE_PRESETS = [
  { label: "UTC", value: "UTC" },
  { label: "Eastern (US)", value: "America/New_York" },
  { label: "Pacific (US)", value: "America/Los_Angeles" },
  { label: "Central European", value: "Europe/Paris" },
  { label: "Manila", value: "Asia/Manila" },
];

function cronToHumanReadable(cron: string): string {
  const preset = SCHEDULE_PRESETS.find((p) => p.value === cron);
  if (preset) return preset.label;
  return cron;
}

export function SchedulesView() {
  const queryClient = useQueryClient();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("");
  const [selectedCron, setSelectedCron] = useState("");
  const [selectedTimezone, setSelectedTimezone] = useState("UTC");
  const [selectedModelRef, setSelectedModelRef] = useState<ModelRef | null>(
    null
  );
  const [mutationError, setMutationError] = useState<string | null>(null);

  const {
    data: schedulesData,
    isLoading: schedulesLoading,
    error: schedulesError,
  } = useQuery({
    queryKey: ["schedules"],
    queryFn: fetchSchedules,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 2,
  });

  const {
    data: agentsData,
    isLoading: agentsLoading,
    error: agentsError,
  } = useQuery({
    queryKey: ["agents"],
    queryFn: fetchAgents,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    retry: 2,
  });

  const {
    data: modelsData,
    isLoading: modelsLoading,
    error: modelsError,
  } = useModels();

  // Set default model when models data loads
  useEffect(() => {
    if (modelsData?.defaultRef && !selectedModelRef) {
      setSelectedModelRef(modelsData.defaultRef);
    }
  }, [modelsData?.defaultRef, selectedModelRef]);

  const createMutation = useMutation({
    mutationFn: createSchedule,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      setPrompt("");
      setSelectedAgent("");
      setSelectedCron("");
      setSelectedTimezone("UTC");
      setSelectedModelRef(modelsData?.defaultRef ?? null);
      setIsFormOpen(false);
      setMutationError(null);
    },
    onError: (error: Error) => {
      setMutationError(error.message);
    },
  });

  const updateMutation = useMutation({
    mutationFn: updateSchedule,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      setMutationError(null);
    },
    onError: (error: Error) => {
      setMutationError(error.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteSchedule,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      setMutationError(null);
    },
    onError: (error: Error) => {
      setMutationError(error.message);
    },
  });

  const handleCreate = () => {
    if (!prompt.trim() || !selectedAgent || !selectedCron || !selectedModelRef)
      return;
    createMutation.mutate({
      graphId: selectedAgent,
      input: {
        messages: [{ role: "user", content: prompt.trim() }],
        modelRef: selectedModelRef,
      },
      cron: selectedCron,
      timezone: selectedTimezone,
    });
  };

  const handleToggle = (id: string, currentEnabled: boolean) => {
    updateMutation.mutate({ id, data: { enabled: !currentEnabled } });
  };

  const handleDelete = (id: string) => {
    deleteMutation.mutate(id);
  };

  const agents = agentsData?.agents ?? [];
  const schedules = schedulesData?.schedules ?? [];
  const models = modelsData?.models ?? [];
  const defaultModelId = modelsData?.defaultRef?.modelId ?? "";
  const hasAgents = agents.length > 0;
  const hasModels = models.length > 0;
  const isFormValid =
    prompt.trim() &&
    selectedAgent &&
    selectedCron &&
    selectedModelRef &&
    hasAgents &&
    hasModels;

  if (schedulesError || agentsError || modelsError) {
    const error = schedulesError ?? agentsError ?? modelsError;
    return (
      <div className="mx-auto flex max-w-[var(--max-width-container-screen)] flex-col gap-8 p-4 md:p-8 lg:px-16">
        <div className="rounded-lg border border-destructive bg-destructive/10 p-6">
          <h2 className="font-semibold text-destructive text-lg">
            Error loading data
          </h2>
          <p className="text-muted-foreground text-sm">
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        </div>
      </div>
    );
  }

  if (schedulesLoading || agentsLoading || modelsLoading) {
    return (
      <div className="mx-auto flex max-w-[var(--max-width-container-screen)] flex-col gap-8 p-4 md:p-8 lg:px-16">
        <div className="animate-pulse space-y-8">
          <div className="h-8 w-48 rounded-md bg-muted" />
          <div className="h-64 rounded-lg bg-muted" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[var(--max-width-container-screen)] flex-col gap-8 p-4 md:p-8 lg:px-16">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="font-bold text-3xl tracking-tight">Schedules</h1>
        <Button
          variant="default"
          size="sm"
          onClick={() => setIsFormOpen(!isFormOpen)}
        >
          {isFormOpen ? (
            <ChevronUp className="mr-2 h-4 w-4" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          {isFormOpen ? "Close" : "Create Schedule"}
        </Button>
      </div>

      {/* Mutation Error */}
      {mutationError && (
        <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
          <p className="text-destructive text-sm">{mutationError}</p>
        </div>
      )}

      {/* Create Form */}
      {isFormOpen && (
        <div className="rounded-lg border bg-card p-6">
          <h2 className="mb-4 font-semibold text-lg">New Schedule</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {/* Prompt */}
            <div className="md:col-span-2">
              <label
                htmlFor="prompt"
                className="mb-2 block font-medium text-sm"
              >
                Prompt
              </label>
              <Input
                id="prompt"
                placeholder="Enter the prompt for this scheduled run..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>

            {/* Agent Select */}
            <div>
              <label htmlFor="agent" className="mb-2 block font-medium text-sm">
                Agent
              </label>
              {!hasAgents ? (
                <p className="text-muted-foreground text-sm">
                  No agents available. Configure agents first.
                </p>
              ) : (
                <Select value={selectedAgent} onValueChange={setSelectedAgent}>
                  <SelectTrigger id="agent">
                    <SelectValue placeholder="Select an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((agent) => (
                      <SelectItem key={agent.graphId} value={agent.graphId}>
                        {agent.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Model Select */}
            <div>
              <div className="mb-2 font-medium text-sm">Model</div>
              <ModelPicker
                models={models}
                value={selectedModelRef?.modelId || defaultModelId}
                onValueChange={setSelectedModelRef}
                disabled={!hasModels}
              />
            </div>

            {/* Frequency Select */}
            <div>
              <label
                htmlFor="frequency"
                className="mb-2 block font-medium text-sm"
              >
                Frequency
              </label>
              <Select value={selectedCron} onValueChange={setSelectedCron}>
                <SelectTrigger id="frequency">
                  <SelectValue placeholder="Select frequency" />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULE_PRESETS.map((preset) => (
                    <SelectItem key={preset.value} value={preset.value}>
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Timezone Select */}
            <div>
              <label
                htmlFor="timezone"
                className="mb-2 block font-medium text-sm"
              >
                Timezone
              </label>
              <Select
                value={selectedTimezone}
                onValueChange={setSelectedTimezone}
              >
                <SelectTrigger id="timezone">
                  <SelectValue placeholder="Select timezone" />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONE_PRESETS.map((tz) => (
                    <SelectItem key={tz.value} value={tz.value}>
                      {tz.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Submit */}
            <div className="flex items-end md:col-span-2">
              <Button
                variant="default"
                onClick={handleCreate}
                disabled={!isFormValid || createMutation.isPending}
              >
                {createMutation.isPending ? "Creating..." : "Create Schedule"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Schedules Table */}
      {schedules.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center">
          <p className="text-muted-foreground">No schedules</p>
          <p className="mt-2 text-muted-foreground text-sm">
            Create your first schedule to automate graph runs.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Prompt</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Timezone</TableHead>
                <TableHead>Latest Trace</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.map((schedule) => {
                const promptText =
                  typeof schedule.input?.messages === "object" &&
                  Array.isArray(schedule.input.messages) &&
                  schedule.input.messages.length > 0
                    ? String(
                        (
                          schedule.input.messages[0] as {
                            content?: unknown;
                          }
                        )?.content ?? ""
                      )
                    : "—";

                return (
                  <TableRow key={schedule.id}>
                    <TableCell>
                      <Badge
                        intent={schedule.enabled ? "default" : "secondary"}
                        size="sm"
                      >
                        {schedule.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium">
                      {schedule.graphId.split(":").pop() ?? schedule.graphId}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {(() => {
                        const input = schedule.input as
                          | Record<string, unknown>
                          | undefined;
                        const ref = input?.modelRef as
                          | { modelId?: string }
                          | undefined;
                        return (
                          ref?.modelId ??
                          (typeof input?.model === "string" ? input.model : "—")
                        );
                      })()}
                    </TableCell>
                    <TableCell className="max-w-xs truncate">
                      {promptText.length > 50
                        ? `${promptText.slice(0, 50)}...`
                        : promptText}
                    </TableCell>
                    <TableCell>{cronToHumanReadable(schedule.cron)}</TableCell>
                    <TableCell>{schedule.timezone}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      No runs yet
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            handleToggle(schedule.id, schedule.enabled)
                          }
                          disabled={updateMutation.isPending}
                        >
                          {schedule.enabled ? "Disable" : "Enable"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(schedule.id)}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
