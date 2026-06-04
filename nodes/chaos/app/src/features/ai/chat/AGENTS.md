# features/ai/chat · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Status:** draft
- **Parent:** [features/ai](../AGENTS.md)

## Purpose

Chat subfeature of AI — provides assistant-ui + AI SDK streaming integration for conversational AI interface. Chat is owned by AI feature, not a separate domain.

## Pointers

- [Root AGENTS.md](../../../../../../AGENTS.md)
- [Parent: AI Feature](../AGENTS.md)
- [Architecture](../../../../../../docs/spec/architecture.md)
- [UI Implementation Guide](../../../../../../docs/spec/ui-implementation.md)
- **Related:** [../services/](../services/) (completion, AI logic), [../../payments/](../../payments/) (credits), [adapters/](adapters/) (dictation adapter)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["core", "ports", "shared", "types", "components", "contracts"],
  "must_not_import": ["app", "adapters"]
}
```

## Ownership

**AI feature owns all LLM interaction endpoints and runtimes:**

- Chat is an AI subfeature: assistant-ui integration, runtime provider, chat UI composition
- No separate sibling feature may implement AI chat logic
- All chat behavior routes through AI services layer

## Public Surface

- **Exports:** ChatRuntimeProvider, ChatCreditsHint, mapHttpError, toErrorAlertProps, useThreads, useLoadThread, useDeleteThread, createWebSpeechDictationAdapter, isSpeechRecognitionSupported
- **Routes:**
  - `/api/v1/ai/chat` (POST) - chat with server-authoritative thread persistence
  - `/api/v1/ai/threads` (GET) - list threads
  - `/api/v1/ai/threads/[stateKey]` (GET, DELETE) - load/delete thread
- **Files considered API:** providers/ChatRuntimeProvider.client.tsx, hooks/useThreads.ts, components/ChatCreditsHint.tsx, utils/mapHttpError.ts, utils/toErrorAlertProps.ts, adapters/web-speech-dictation.adapter.ts

## Ports

- **Uses ports:** none (delegates to AI completion services via API route)
- **Implements ports:** none
- **Contracts:** ai.chat.v1 (wire format), ai.threads.v1 (thread list/load/delete)

## Responsibilities

- **This subfeature does:**
  - Provide chat UI using assistant-ui components
  - Manage chat runtime state with useChatRuntime + DefaultChatTransport
  - Send single user message text via prepareSendMessagesRequest (not full history)
  - Capture stateKey from X-State-Key response header for multi-turn continuity
  - Support thread switching via initialMessages + initialStateKey props (key-based remount)
  - Provide React Query hooks for thread list, load, and delete operations
  - Show conditional credits hint when balance is zero
  - Handle abort/cancellation without state corruption
  - Provide Web Speech API dictation adapter for voice-to-text input (progressive enhancement)

- **This subfeature does not:**
  - Handle authentication (enforced by (app) layout)
  - Manage billing (delegated to AI completion services)
  - Contain AI business logic (owned by features/ai/services)

## Implementation Status

- useChatRuntime + DefaultChatTransport (AI SDK Data Stream Protocol)
- /api/v1/ai/chat: createUIMessageStream SSE streaming
- Server-authoritative thread persistence (ai_threads table)
- Client sends `{ message, model, graphName, stateKey? }` — no history replay
- Multi-turn conversation state via stateKey + server-loaded UIMessage[] history
- Tool call visualization (tool_call_start/tool_call_result → UIMessageChunk)
- assistant_final reconciliation (gateway truncation fix)
- Zod runtime validation on input; contract types via z.infer
- Web Speech API DictationAdapter via adapters/web-speech-dictation.adapter.ts (progressive enhancement)

## Thread State Management

### Current Design

**Contract:**

- Request: `{ message: string, model, graphName, stateKey?: string }`
- Response: AI SDK Data Stream Protocol (SSE) + `X-State-Key` header
- Server generates `stateKey` if absent; client reuses for multi-turn

**Client Transport Pattern:**

```typescript
const runtime = useChatRuntime({
  transport: new DefaultChatTransport({
    api: "/api/v1/ai/chat",
    prepareSendMessagesRequest: ({ messages }) => ({
      body: {
        message: extractLastUserText(messages),
        model,
        graphName,
        stateKey,
      },
    }),
    fetch: async (url, init) => {
      /* intercept response for stateKey capture */
    },
  }),
});
```

**stateKey lifecycle:** stateKeyMap pattern supports future thread switching/forks.

### Naming Convention

| Layer        | Field       | Notes                                                     |
| ------------ | ----------- | --------------------------------------------------------- |
| UI State     | `stateKey`  | App-level key for state/thread selection                  |
| API/Contract | `stateKey`  | Client-facing conversation key (provider-agnostic)        |
| Port/Adapter | `stateKey`  | Passed through; adapter decides semantics                 |
| LangGraph    | `thread_id` | UUID format derived from (accountId, stateKey) by adapter |
| Claude SDK   | `sessionId` | Claude Agents SDK uses sessionId for conversation state   |
| Langfuse     | `sessionId` | Derived via hash: `ba:{accountId}:s:{sha256(stateKey)}`   |

**Note:** `stateKey` is canonical at Cogni boundaries; providers derive their own identifiers internally.

## Usage

```typescript
import { ChatRuntimeProvider } from "@/features/ai/chat/providers/ChatRuntimeProvider.client";
import { Thread } from "@/components";

<ChatRuntimeProvider onAuthExpired={() => signOut()}>
  <Thread welcomeMessage={<CustomWelcome />} />
</ChatRuntimeProvider>
```

## Standards

- Contract types via z.infer only - no manual interfaces
- Zod runtime validation on route input and client output
- Ref-based state management to avoid stale closures
- AbortController wiring for v1 streaming readiness

## Dependencies

- **Internal:** @/contracts/ai.chat.v1.contract, @/features/payments/public, @/components/vendor/assistant-ui, @/components/vendor/shadcn
- **External:** @assistant-ui/react, @assistant-ui/react-ai-sdk, @assistant-ui/react-markdown, ai (AI SDK), @tanstack/react-query, next-auth

## Change Protocol

- On wire format change: Update ai.chat.v1 contract first, then fix TypeScript errors
- Breaking changes: Bump to ai.chat.v2
- All types from contract via z.infer — no manual interfaces

## Notes

- Chat streaming uses AI SDK Data Stream Protocol (SSE), not custom wire format
- `createUIMessageStream` does NOT auto-emit finish — route must manually write `{ type: "finish" }`
