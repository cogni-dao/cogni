// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/components/ModelPicker`
 * Purpose: Provides model selection dialog for chat interface.
 * Scope: Feature-specific controlled UI component for selecting AI models. Does not manage state, persistence, or API data (delegates to parent).
 * Invariants: Responsive CSS (mobile bottom-sheet, desktop centered modal).
 * Side-effects: none (controlled component, delegates state to parent)
 * Notes: Uses Dialog+ScrollArea from shadcn, provider icons from config.
 * Links: Used by ChatComposerExtras, provider-icons config
 * @internal
 */

"use client";

import type { ModelRef } from "@cogni/ai-core";
import type { Model } from "@cogni/node-contracts";
import { cn } from "@cogni/node-ui-kit/util/cn";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/kit/overlays/Dialog";
import { resolveModelIcon } from "@/features/ai/config/provider-icons";
import { OpenAIIcon } from "@/features/ai/icons/providers/OpenAIIcon";

export type LlmBackend = "openrouter" | "chatgpt" | "local";

/**
 * Models available via ChatGPT subscription (Codex transport).
 * Only Codex-specific models work with ChatGPT account auth.
 * Standard models (gpt-4o-mini, o3, etc.) are NOT supported.
 */
// Exported so validation logic can include these in the valid model set.
// TODO: Replace with a unified /api/v1/ai/models endpoint that returns
// models from ALL backends (OpenRouter, ChatGPT, Ollama, etc.)
export const CHATGPT_MODELS = [
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    description: "Most capable — 1M context, 128K output",
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    description: "Fast and capable — best value",
  },
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    description: "Default — balanced performance",
  },
  {
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Spark",
    description: "Fast and lightweight — 128K context",
  },
  {
    id: "gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    description: "Previous generation",
  },
  {
    id: "gpt-5.1-codex",
    name: "GPT-5.1 Codex",
    description: "Older generation",
  },
  {
    id: "gpt-5.1-codex-mini",
    name: "GPT-5.1 Mini",
    description: "Smallest and fastest",
  },
  {
    id: "gpt-5.1-codex-max",
    name: "GPT-5.1 Max",
    description: "Maximum context — previous gen",
  },
] as const;

export interface ModelPickerProps {
  models: Model[];
  value: string;
  onValueChange: (ref: ModelRef) => void;
  disabled?: boolean;
  balance?: number;
}

export function ModelPicker({
  models,
  value,
  onValueChange,
  disabled,
  balance = 0,
}: Readonly<ModelPickerProps>) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Initialize backend tab from current model value
  const initialBackend = CHATGPT_MODELS.some((m) => m.id === value)
    ? "chatgpt"
    : "openrouter";
  const [backend, setBackend] = useState<LlmBackend>(initialBackend);
  const [connectionId, setConnectionId] = useState<string | undefined>(
    undefined
  );
  const [localConnectionId, setLocalConnectionId] = useState<
    string | undefined
  >(undefined);

  // Fetch connection statuses once on mount.
  // If current model is ChatGPT but missing connectionId (page reload),
  // propagate it via onValueChange when the fetch completes.
  useEffect(() => {
    fetch("/api/v1/auth/openai-codex/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { connected: boolean; connectionId?: string } | null) => {
        if (data?.connected && data.connectionId) {
          setConnectionId(data.connectionId);
        }
      })
      .catch(() => {});

    fetch("/api/v1/auth/openai-compatible/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { connected: boolean; connectionId?: string } | null) => {
        if (data?.connected && data.connectionId) {
          setLocalConnectionId(data.connectionId);
        }
      })
      .catch(() => {});
  }, []);

  // When connectionId arrives and the active model is ChatGPT, patch the
  // modelRef so the missing connectionId is filled in (page-reload scenario).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only fire when connectionId resolves, not on every value/onValueChange change
  useEffect(() => {
    if (connectionId && CHATGPT_MODELS.some((m) => m.id === value)) {
      onValueChange({ providerKey: "codex", modelId: value, connectionId });
    }
  }, [connectionId]);

  // Track last-used model per backend so switching back restores selection
  const [lastOpenRouterModel, setLastOpenRouterModel] = useState(value);

  // Split models by provider for tab rendering
  const localModels = models.filter(
    (m) => m.ref.providerKey === "openai-compatible"
  );
  const platformModels = models.filter(
    (m) =>
      m.ref.providerKey !== "openai-compatible" && m.ref.providerKey !== "codex"
  );

  const handleBackendChange = (b: LlmBackend) => {
    setBackend(b);
    if (b === "chatgpt") {
      setLastOpenRouterModel(value);
      onValueChange({
        providerKey: "codex",
        modelId: CHATGPT_MODELS[0].id,
        connectionId,
      });
    } else if (b === "local") {
      setLastOpenRouterModel(value);
      const firstLocal = localModels[0];
      if (firstLocal) {
        onValueChange(firstLocal.ref);
      }
    } else {
      // Restore last OpenRouter model — find its ref from models list
      const orModel = models.find((m) => m.ref.modelId === lastOpenRouterModel);
      onValueChange(
        orModel?.ref ?? {
          providerKey: "platform",
          modelId: lastOpenRouterModel,
        }
      );
    }
  };

  const isChatGptModel = CHATGPT_MODELS.some((m) => m.id === value);
  const selectedOpenRouterModel = models.find((m) => m.ref.modelId === value);
  const selectedChatGptModel = CHATGPT_MODELS.find((m) => m.id === value);
  const filteredModels = platformModels.filter((model) => {
    const query = searchQuery.toLowerCase();
    return (
      model.ref.modelId.toLowerCase().includes(query) ||
      model.label.toLowerCase().includes(query)
    );
  });

  const displayName =
    backend === "chatgpt" && isChatGptModel
      ? selectedChatGptModel?.name
      : selectedOpenRouterModel?.label ||
        selectedOpenRouterModel?.ref.modelId ||
        "Select model";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            // Base styles - rounded-full like attachment button, proper sizing
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5",
            "h-[var(--size-composer-icon-btn)] w-auto",
            "border-none bg-transparent shadow-none outline-none",
            // Typography - match attachment button
            "font-semibold text-muted-foreground text-xs",
            // Hover - use semantic accent tokens (matches card hover)
            "transition-colors hover:bg-accent hover:text-foreground",
            // Active/expanded state
            "aria-[expanded=true]:bg-accent aria-[expanded=true]:text-foreground",
            // Disabled state
            "disabled:pointer-events-none disabled:opacity-50"
          )}
          aria-label="Select model"
        >
          <span className="max-w-[var(--max-width-model-trigger)] truncate">
            {displayName}
          </span>
          <ChevronDown className="size-4 shrink-0" />
        </button>
      </DialogTrigger>

      <DialogContent
        className={cn(
          // Mobile: centered card with margins
          "fixed inset-3 top-auto w-auto max-w-none translate-x-0 translate-y-0 rounded-2xl",
          "max-h-[var(--max-height-dialog-mobile)]",
          // Desktop: centered modal
          "sm:inset-auto sm:top-[var(--center-50)] sm:left-[var(--center-50)] sm:w-full",
          "sm:translate-x-[var(--center-neg-50)] sm:translate-y-[var(--center-neg-50)]",
          "sm:max-h-[var(--max-height-dialog)] sm:max-w-lg sm:rounded-2xl",
          // Shared — override base grid with flex
          "flex flex-col gap-4"
        )}
      >
        <DialogHeader>
          <DialogTitle>Select Model</DialogTitle>
        </DialogHeader>

        {/* Provider toggle — always visible */}
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          <button
            type="button"
            onClick={() => handleBackendChange("openrouter")}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-1.5 font-medium text-sm transition-colors",
              backend === "openrouter"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <svg
              className="size-4"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
            </svg>
            OpenRouter
          </button>
          <button
            type="button"
            onClick={() => handleBackendChange("chatgpt")}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-1.5 font-medium text-sm transition-colors",
              backend === "chatgpt"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <OpenAIIcon className="size-4" />
            ChatGPT
          </button>
          <button
            type="button"
            onClick={() => handleBackendChange("local")}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-1.5 font-medium text-sm transition-colors",
              backend === "local"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <svg
              className="size-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
              <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
              <line x1="6" x2="6.01" y1="6" y2="6" />
              <line x1="6" x2="6.01" y1="18" y2="18" />
            </svg>
            Local
          </button>
        </div>

        {backend === "local" ? (
          localConnectionId ? (
            localModels.length > 0 ? (
              /* Local connected + models available */
              <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6">
                <div className="space-y-1">
                  {localModels.map((model) => {
                    const isSelected = value === model.ref.modelId;
                    return (
                      <button
                        key={model.ref.modelId}
                        type="button"
                        onClick={() => {
                          onValueChange(model.ref);
                          setOpen(false);
                        }}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left",
                          "transition-colors hover:bg-accent",
                          isSelected && "bg-accent"
                        )}
                      >
                        <svg
                          className="size-5 shrink-0 text-muted-foreground"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <rect
                            width="20"
                            height="8"
                            x="2"
                            y="2"
                            rx="2"
                            ry="2"
                          />
                          <rect
                            width="20"
                            height="8"
                            x="2"
                            y="14"
                            rx="2"
                            ry="2"
                          />
                          <line x1="6" x2="6.01" y1="6" y2="6" />
                          <line x1="6" x2="6.01" y1="18" y2="18" />
                        </svg>
                        <div className="min-w-0 flex-1 truncate font-medium text-sm">
                          {model.label}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="font-medium text-sm text-success">
                            $0
                          </span>
                          {isSelected && (
                            <Check className="size-4 text-primary" />
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              /* Local connected but no models */
              <div className="-mx-6 px-6">
                <div className="rounded-md border border-border px-3 py-4 text-center text-muted-foreground text-sm">
                  No models found on your endpoint. Pull a model first.
                </div>
              </div>
            )
          ) : (
            /* Local not connected */
            <div className="-mx-6 px-6">
              <a
                href="/profile"
                className="flex w-full items-center gap-3 rounded-md border border-border px-3 py-4 text-left transition-colors hover:bg-accent"
              >
                <svg
                  className="size-5 shrink-0 text-muted-foreground"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
                  <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
                  <line x1="6" x2="6.01" y1="6" y2="6" />
                  <line x1="6" x2="6.01" y1="18" y2="18" />
                </svg>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm">Connect Local LLM</div>
                  <div className="text-muted-foreground text-xs">
                    Add your Ollama or vLLM endpoint in Profile
                  </div>
                </div>
              </a>
            </div>
          )
        ) : backend === "chatgpt" ? (
          connectionId ? (
            /* ChatGPT connected — show available models */
            <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6">
              <div className="space-y-1">
                {CHATGPT_MODELS.map((model) => {
                  const isSelected = value === model.id;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() => {
                        onValueChange({
                          providerKey: "codex",
                          modelId: model.id,
                          connectionId,
                        });
                        setOpen(false);
                        setSearchQuery("");
                      }}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left",
                        "transition-colors hover:bg-accent",
                        isSelected && "bg-accent"
                      )}
                    >
                      <OpenAIIcon className="size-5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-sm">
                          {model.name}
                        </div>
                        {model.description && (
                          <div className="text-muted-foreground text-xs">
                            {model.description}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="font-medium text-sm text-success">
                          $0
                        </span>
                        {isSelected && (
                          <Check className="size-4 text-primary" />
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            /* ChatGPT not connected — link to profile */
            <div className="-mx-6 px-6">
              <a
                href="/profile"
                className="flex w-full items-center gap-3 rounded-md border border-border px-3 py-4 text-left transition-colors hover:bg-accent"
              >
                <OpenAIIcon className="size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm">Connect ChatGPT</div>
                  <div className="text-muted-foreground text-xs">
                    Link your ChatGPT subscription in Profile to unlock $0 AI
                  </div>
                </div>
              </a>
            </div>
          )
        ) : (
          /* OpenRouter backend — full model list */
          <>
            {/* Search input */}
            <input
              type="text"
              placeholder="Search models..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring focus:ring-offset-background"
            />

            {/* Models list */}
            <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6">
              <div className="space-y-1">
                {filteredModels.length === 0 ? (
                  <div className="py-6 text-center text-muted-foreground text-sm">
                    No models found
                  </div>
                ) : (
                  filteredModels.map((model) => {
                    const Icon = resolveModelIcon(
                      model.ref.providerKey,
                      model.ref.modelId
                    );
                    const isSelected = model.ref.modelId === value;
                    const isPaidAndNoBalance =
                      model.requiresPlatformCredits && balance <= 0;

                    return (
                      <button
                        key={model.ref.modelId}
                        type="button"
                        disabled={isPaidAndNoBalance}
                        onClick={() => {
                          if (!isPaidAndNoBalance) {
                            onValueChange(model.ref);
                            setOpen(false);
                            setSearchQuery("");
                          }
                        }}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left",
                          "transition-colors hover:bg-accent",
                          isSelected && "bg-accent",
                          isPaidAndNoBalance &&
                            "cursor-not-allowed opacity-50 hover:bg-transparent"
                        )}
                      >
                        <Icon className="size-5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1 truncate font-medium text-sm">
                          {model.label}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {!model.requiresPlatformCredits && (
                            <span className="flex items-center gap-1.5 font-medium text-sm text-success">
                              {isSelected && <Check className="size-4" />}
                              Free
                            </span>
                          )}
                          {model.requiresPlatformCredits && isSelected && (
                            <Check className="size-4 text-primary" />
                          )}
                          {isPaidAndNoBalance && (
                            <span className="text-muted-foreground text-xs">
                              (Credits required)
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
