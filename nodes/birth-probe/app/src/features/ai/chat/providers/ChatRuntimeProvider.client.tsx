// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/chat/providers/ChatRuntimeProvider`
 * Purpose: Runtime provider for chat using AI SDK streaming with multi-turn state and thread switching.
 * Scope: Feature-local provider. Uses useChatRuntime for AI SDK Data Stream Protocol streaming. Manages stateKey state for conversation continuity. Accepts initialMessages and initialStateKey for loading existing threads. Does not persist messages or manage auth.
 * Invariants:
 *   - CLIENT_SENDS_MESSAGE_ONLY: prepareSendMessagesRequest extracts last user message text and sends { message, modelRef, graphName, stateKey }
 *   - THREAD_STATE_BY_KEY: stateKey stored in stateKeyMap; seeded from initialStateKey for existing threads
 * Side-effects: IO (fetch to /api/v1/ai/chat via runtime)
 * Notes: Uses useChatRuntime from @assistant-ui/react-ai-sdk; captures X-State-Key from response header.
 * Links: ai.chat.v1 contract, chat/AGENTS.md (Thread State Management)
 * @public
 */

"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import type { GraphId, ModelRef } from "@cogni/ai-core";
import type { ChatError } from "@cogni/node-contracts";
import { clientLogger, EVENT_NAMES } from "@cogni/node-shared";
import { useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { DefaultChatTransport } from "ai";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { createWebSpeechDictationAdapter } from "../adapters/web-speech-dictation.adapter";
import { mapHttpError } from "../utils/mapHttpError";

/**
 * Ref handle for ChatRuntimeProvider
 */
export interface ChatRuntimeRef {
  retryLastSend: () => void;
}

interface ChatRuntimeProviderProps {
  children: ReactNode;
  /** Fully-resolved model reference (provider + model + optional connection) */
  modelRef: ModelRef;
  selectedGraph: GraphId;
  defaultModelId: string;
  /** Pre-loaded messages for an existing thread, or [] for a new thread. */
  initialMessages: UIMessage[];
  /** stateKey for an existing thread, or null for a new thread. */
  initialStateKey: string | null;
  onAuthExpired?: () => void;
  onError?: (error: ChatError) => void;
  /** Called after each assistant response finishes (for sidebar refresh, etc.). */
  onFinish?: () => void;
}

export function ChatRuntimeProvider({
  children,
  modelRef,
  selectedGraph,
  defaultModelId,
  initialMessages,
  initialStateKey,
  onAuthExpired,
  onError,
  onFinish,
}: ChatRuntimeProviderProps) {
  const queryClient = useQueryClient();
  const modelRefRef = useRef(modelRef);
  const selectedGraphRef = useRef(selectedGraph);

  // State key for multi-turn conversations
  // When initialStateKey is provided (existing thread), seed the map so stateKey is
  // always included in prepareSendMessagesRequest — impossible to omit for existing threads.
  const activeStateKey = "default";
  const [stateKeyMap, setStateKeyMap] = useState<Record<string, string>>(
    initialStateKey != null ? { [activeStateKey]: initialStateKey } : {}
  );
  const stateKey = stateKeyMap[activeStateKey];
  const stateKeyRef = useRef(stateKey);

  // Keep refs in sync
  useEffect(() => {
    modelRefRef.current = modelRef;
  }, [modelRef]);

  useEffect(() => {
    selectedGraphRef.current = selectedGraph;
  }, [selectedGraph]);

  useEffect(() => {
    stateKeyRef.current = stateKey;
  }, [stateKey]);

  // Handle response - capture stateKey and handle errors
  const handleResponse = useCallback(
    async (response: Response) => {
      // Capture stateKey from response header for multi-turn continuity
      // Server generates stateKey on first request, we reuse it for subsequent requests
      const newStateKey = response.headers.get("X-State-Key");
      if (newStateKey && newStateKey !== stateKeyRef.current) {
        setStateKeyMap((prev) => ({
          ...prev,
          [activeStateKey]: newStateKey,
        }));
      }

      if (response.status === 401) {
        onAuthExpired?.();
        throw new Error("Unauthorized");
      }

      if (response.status === 402) {
        const body = await response.json().catch(() => ({}));
        const error = mapHttpError(402, body, crypto.randomUUID());
        onError?.(error);
        throw new Error("Insufficient credits");
      }

      if (response.status === 409) {
        // UX-001: Invalid model - log warning but let retry happen via body.model
        clientLogger.warn(EVENT_NAMES.CLIENT_CHAT_MODEL_INVALID_RETRY, {
          model: modelRefRef.current.modelId,
          defaultModelId,
        });
        // The server returns defaultModelId in the 409 response
        // For now, throw to trigger retry - user can resend with default model
        throw new Error("Invalid model");
      }

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const error = mapHttpError(response.status, body, crypto.randomUUID());
        onError?.(error);
        throw new Error(body.error || "Request failed");
      }
    },
    [defaultModelId, onAuthExpired, onError]
  );

  // Handle stream finish - invalidate credits query + notify parent
  const handleFinish = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["payments-summary"] });
    onFinish?.();
  }, [queryClient, onFinish]);

  // Dictation adapter — stable across renders (Web Speech API availability doesn't change)
  const dictationAdapter = useMemo(() => createWebSpeechDictationAdapter(), []);

  // Transport-level options (api, request shape, response interception) must be
  // on the transport — they are NOT valid ChatInit/useChatRuntime options.
  // useDynamicChatTransport inside useChatRuntime wraps this in a ref-based
  // proxy, so recreating each render is safe.
  const runtime = useChatRuntime({
    messages: initialMessages,
    adapters: dictationAdapter ? { dictation: dictationAdapter } : undefined,
    transport: new DefaultChatTransport({
      api: "/api/v1/ai/chat",
      prepareSendMessagesRequest: ({ messages }) => ({
        body: {
          message: extractLastUserText(messages),
          modelRef: modelRefRef.current,
          graphName: selectedGraphRef.current,
          ...(stateKeyRef.current ? { stateKey: stateKeyRef.current } : {}),
        },
      }),
      // Wrap fetch to intercept responses (stateKey capture + error handling).
      // ChatInit has no onResponse; fetch wrapper is the transport-level equivalent.
      fetch: async (url, init) => {
        const response = await globalThis.fetch(url, init);
        await handleResponse(response);
        return response;
      },
    }),
    onFinish: handleFinish,
    onError: (error) => {
      clientLogger.error(EVENT_NAMES.CLIENT_CHAT_STREAM_ERROR, {
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });

  // Note: disabled prop is handled by parent - composer should be disabled there

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}

/**
 * Extract the text content from the last user message in the messages array.
 * Falls back to empty string if no user message found.
 */
function extractLastUserText(
  messages: Array<{
    role: string;
    parts?: Array<{ type: string; text?: string }>;
  }>
): string {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUserMsg?.parts) return "";
  return lastUserMsg.parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text as string)
    .join("\n");
}
