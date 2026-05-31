# AI Feature - Design Specification

> **Status:** Phase 1 (MVP) - Barebones proof of concept
> **Owner:** AI Feature Team
> **Last Updated:** 2025-11-13

## Overview

Minimal AI chat completion feature implementing strict hexagonal architecture. Provides basic message-in/response-out functionality via LiteLLM → OpenRouter integration.

## Architecture Alignment

This feature strictly follows the project's hexagonal architecture with proper layer separation:

```
app/api → features/ai → ports/llm → core/chat
                    ↙
adapters/server/ai → ports/llm
```

**Critical Constraints:**

- Core has no I/O, time, or RNG dependencies
- Features never import contracts or adapters
- Ports depend on core types only
- UI follows kit → feature composition pattern

## File Layout & Responsibilities

### Core Domain Layer

**Pure business logic, no dependencies**

#### `src/core/chat/model.ts`

**Scope:** Domain entities and value objects
**Role:** Define message structures with ISO timestamps (not Date objects)

```typescript
export interface Message {
  role: MessageRole;
  content: string;
  timestamp?: string; // ISO 8601 string, optional - set server-side
}
export type MessageRole = "user" | "assistant" | "system";
export interface Conversation {
  id: string;
  messages: Message[];
}
```

#### `src/core/chat/rules.ts`

**Scope:** Pure business rules and validation
**Role:** Deterministic validation with actionable results

```typescript
// Validation errors with enum codes for clean HTTP mapping
export enum ChatErrorCode {
  MESSAGE_TOO_LONG = "MESSAGE_TOO_LONG",
  INVALID_CONTENT = "INVALID_CONTENT",
}

export class ChatValidationError extends Error {
  constructor(
    public code: ChatErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ChatValidationError";
  }
}

// Deterministic validation - throws ChatValidationError
export function assertMessageLength(content: string): void;

// Char-based trimming: deterministic, idempotent heuristic for v0
// Explicitly documented - NOT token-based, handles multi-byte chars correctly
export function trimConversationHistory(
  messages: Message[],
  maxChars: number
): Message[];

// System message filtering (server-side only)
export function filterSystemMessages(messages: Message[]): Message[];

// Role normalization and validation
export function normalizeMessageRole(role: string): MessageRole | null;
```

### Port Interface

**Abstract dependencies the domain needs**

#### `src/ports/llm.port.ts`

**Scope:** LLM service abstraction
**Role:** Future-ready interface that won't require refactoring

```typescript
import { Message } from "@/core/chat/model";

export interface LlmService {
  complete(params: {
    messages: Message[];
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<Message>;
}
```

### Contract Layer

**Edge IO definition with DTO mapping**

#### `src/contracts/ai.complete.v1.contract.ts`

**Scope:** External API contract with DTOs
**Role:** Isolate internal types from external API

```typescript
// DTOs that don't leak core internals
const InputMessageDtoSchema = z.object({
  role: z.enum(["user", "assistant"]), // No 'system' from client
  content: z.string().max(4000), // Cap client input
  timestamp: z.string().optional(), // Client timestamp ignored - set server-side
});

const OutputMessageDtoSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(65_536), // LLM responses can be long
  timestamp: z.string(),
  requestId: z.string(),
});

export const aiCompletionOperation = {
  id: "ai.completion.v1",
  summary: "Chat completion via AI",
  input: z.object({
    messages: z.array(InputMessageDtoSchema),
    model: z.string(),
    graphName: z.string(),
  }),
  output: z.object({
    message: OutputMessageDtoSchema,
  }),
} as const;
```

### Feature Layer

**Orchestration and feature-specific logic**

#### `src/features/ai/services/complete.ts`

**Scope:** Use case orchestration
**Role:** Coordinate core rules, port calls, set output timestamp
**Dependencies:** `@/core/chat/*`, `@/ports/llm.port` ONLY

```typescript
import {
  assertMessageLength,
  trimConversationHistory,
  filterSystemMessages,
} from "@/core/chat/rules";
import { type Message } from "@/core/chat/model";
import { type LlmService } from "@/ports/llm.port.ts";

export async function execute(
  messages: Message[],
  llmService: LlmService
): Promise<Message> {
  // Apply core business rules first
  const userMessages = filterSystemMessages(messages);

  for (const message of userMessages) {
    assertMessageLength(message.content); // Throws ChatValidationError
  }

  const trimmedMessages = trimConversationHistory(userMessages, 4000);

  // Delegate to port - adapter handles model/param defaults from env
  return await llmService.complete({ messages: trimmedMessages });
}
```

#### `src/features/ai/components/ChatInterface.tsx`

**Scope:** Feature-specific UI composition
**Role:** Compose generic kit components with AI-specific logic
**Dependencies:** `@/components` (kit only)

```typescript
import { ChatInput, ChatMessage } from "@/components";
import { useState } from "react";

export function ChatInterface() {
  // Feature-specific state and logic
  // Composes generic kit components
  // Handles AI completion calls
}
```

### Adapter Layer

**Infrastructure implementation**

#### `src/adapters/server/ai/litellm.adapter.ts`

**Scope:** LiteLLM service implementation
**Role:** Implement LlmService port
**Dependencies:** `@/ports/llm.port.ts`, `@/shared/env/server.ts`

```typescript
import { type LlmService } from "@/ports/llm.port.ts";
import { serverEnv } from "@/shared/env/server";

export class LiteLlmAdapter implements LlmService {
  async complete(params: {
    messages: Message[];
    model: string; // Required - computed from LiteLLM catalog metadata
    temperature?: number;
    maxTokens?: number;
  }): Promise<Message> {
    // Model is required - defaults computed from LiteLLM catalog metadata.cogni.* tags
    const model = params.model;
    const temperature = params.temperature ?? 0.7;
    const maxTokens = params.maxTokens ?? 2048;

    // HTTP calls to LITELLM_BASE_URL
    // Convert core Message[] to LiteLLM format
    // Handle streaming in future phases

    // Return with server-generated timestamp
    return {
      role: "assistant",
      content: response.content,
      timestamp: new Date().toISOString(),
    };
  }
}
```

### Delivery Layer

**External entry point**

#### `src/app/api/v1/ai/complete/route.ts`

**Scope:** HTTP endpoint
**Role:** Validate, translate DTOs, delegate to feature
**Dependencies:** `@/contracts/ai.complete.v1.contract`, `@/features/ai/services/complete`

```typescript
import { aiCompleteOperation } from "@/contracts/ai.complete.v1.contract";
import { execute } from "@/features/ai/services/complete";
import {
  normalizeMessageRole,
  ChatValidationError,
  ChatErrorCode,
} from "@/core/chat/rules";

export async function POST(request: Request) {
  try {
    // Validate input with contract
    const { messages } = aiCompleteOperation.input.parse(await request.json());

    // Server-side role normalization and validation
    const coreMessages = messages.map((dto) => {
      const normalizedRole = normalizeMessageRole(dto.role);
      if (!normalizedRole || normalizedRole === "system") {
        throw new ChatValidationError(
          ChatErrorCode.INVALID_CONTENT,
          `Invalid role: ${dto.role}`
        );
      }

      return {
        role: normalizedRole,
        content: dto.content,
        timestamp: new Date().toISOString(), // Server-controlled timestamp
      };
    });

    // Delegate to feature service
    const response = await execute(coreMessages, llmService);

    // Response already has server-generated timestamp
    const responseDto = {
      message: {
        role: response.role,
        content: response.content,
        timestamp: response.timestamp!, // Non-null assertion safe - set by adapter
      },
    };

    return Response.json(aiCompleteOperation.output.parse(responseDto));
  } catch (error) {
    if (error instanceof ChatValidationError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: 400 }
      );
    }
    throw error;
  }
}
```

### UI Kit Layer (Conditional)

**Generic reusable components**

#### `src/components/kit/inputs/ChatInput.tsx` (Only if truly generic)

**Scope:** Generic chat input component
**Role:** Reusable text input with chat-specific UX
**Constraint:** Must be completely feature-agnostic

```typescript
// Only create if this can be truly generic
// No AI-specific logic, no fetch calls
// Pure presentation component with callbacks
export interface ChatInputProps {
  onSubmit: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
}
```

**Decision Rule:** If ChatInput contains any AI-specific logic or cannot be reused elsewhere, place it in `src/features/ai/components/` instead.

## Data Flow

### Request Flow

```
1. Client → POST /api/v1/ai/complete
2. route.ts → validate with contract DTOs
3. route.ts → translate DTOs to core Message[]
4. route.ts → delegate to features/ai/services/complete
5. complete.ts → apply core/chat/rules validation
6. complete.ts → call ports/llm.port.ts
7. adapters/server/ai/litellm.adapter.ts → implement port
8. LiteLLM → OpenRouter → AI model
9. Response flows back through same layers
10. route.ts → translate core Message to DTO
11. Client receives response
```

### Critical Boundaries

- **Contract → Core:** DTOs translated at route boundary
- **Features → Ports:** No adapter imports allowed
- **Core → External:** No Date objects, no I/O calls
- **UI Kit → Features:** Generic components composed by features

## Security & Validation

### Server-Side Controls

- **System message filtering:** Clients cannot inject system prompts
- **Message length limits:** Enforced in core/chat/rules
- **Rate limiting:** Applied at route level
- **Input sanitization:** Zod validation in contracts

### Error Handling

- **Core validation:** `assertMessageLength()` throws `ChatValidationError` with enum codes
- **Port failures:** Adapter handles LiteLLM timeouts/errors
- **Route errors:** Maps `ChatValidationError` codes to HTTP 400 without leaking internals
- **Role validation:** Route-level guard normalizes/rejects invalid roles

## Testing Strategy

### Unit Tests Required

- `tests/unit/core/chat/rules.test.ts` - Pure business logic
- `tests/unit/features/ai/services/complete.test.ts` - With mocked ports

### Contract Tests Required

- `tests/contract/llm.port.test.ts` - Verify adapter conformance
- `tests/contract/ai.complete.v1.test.ts` - Route contract compliance

### Integration Tests

- `tests/component/ai/litellm.adapter.test.ts` - Against real LiteLLM
- `e2e/ai.spec.ts` - Full request/response cycle

### Security Tests (Required)

- **Adapter test:** Proves no secrets appear in logs (keys, full prompts)
- **Route test:** Rate limiting kicks in (even with stubbed counter)
- **Core test:** `trimConversationHistory` handles boundary cases (exact limit, multi-byte chars)

### Security Tests

- Route rejects client-supplied system messages
- Message length enforcement
- Invalid input handling
- **Adapter security:** No secrets (keys, full prompts) in logs
- **Rate limiting:** Route-level rate limit enforcement (stubbed counter)

## Phase 1: MVP Implementation

### Deliverables

- [x] Core domain types with ISO timestamps
- [x] Deterministic validation rules (char-based heuristic)
- [x] Future-ready port interface
- [x] DTO-isolated contracts
- [x] Feature service with proper orchestration
- [x] LiteLLM adapter implementation
- [x] HTTP route with DTO translation
- [x] Basic UI composition (feature-specific)
- [x] Required test coverage

### Constraints

- No streaming (Phase 2)
- No conversation persistence (Phase 2)
- No LangGraph workflows (Phase 3)
- No assistant-ui integration (Phase 3)
- Char-based trimming heuristic (tokenizer in Phase 2)

## Future Phases

### Phase 2: Enhanced Capabilities

**Add without refactoring existing code**

#### Streaming Support

- Add separate `LlmService.stream()` method returning `AsyncIterable<MessageChunk>`
- Update adapter to handle streaming responses
- Add streaming endpoint alongside existing complete endpoint

#### Token-Aware Trimming

- Add tokenizer strategy to `trimConversationHistory()`
- Implement as dependency injection, not hardcoded logic
- Maintain backward compatibility with char-based heuristic

#### Conversation Persistence

- Add `ConversationRepo` port
- Extend feature service to load/save conversations
- Keep core domain unchanged

### Phase 3: LangGraph Integration

**Leverage existing port abstraction**

#### Workflow Routing

- LangGraph workflows compose `LlmService` (NOT extend it - keep port focused)
- Add workflow registry in feature layer (inspired by cogni-git-review)
- Workflows orchestrate multiple LlmService calls, don't become part of port

#### Assistant-UI Integration

- Add thread management capabilities
- Support human-in-the-loop workflows
- Integrate interrupt handling
- Replace basic UI with assistant-ui components

#### Advanced Features

- Multi-step reasoning workflows
- Tool use and function calling
- Human approval flows
- Thread persistence and restoration

## Validation Checklist

### Architecture Compliance

- [ ] Core has no I/O, time, or framework dependencies
- [ ] Features import only ports, core, shared, components
- [ ] Routes import only contracts, features, shared
- [ ] Adapters import only ports, shared
- [ ] Contracts use DTOs, not core types
- [ ] UI follows kit → feature composition

### Implementation Quality

- [ ] `assertMessageLength()` throws with clear errors
- [ ] `trimConversationHistory()` documented as char-based heuristic
- [ ] Port interface supports future extensions without refactoring
- [ ] System messages filtered server-side
- [ ] DTO translation at route boundary
- [ ] Contract tests for all adapters

### Future Readiness

- [ ] Port design supports streaming extension
- [ ] Core domain supports conversation entities
- [ ] Feature service can delegate to workflow engines
- [ ] UI architecture supports assistant-ui integration
- [ ] No architectural debt from Phase 1 shortcuts

---

This design provides immediate delivery capability while establishing the foundation for sophisticated AI workflows in future phases. The strict architectural discipline ensures no refactoring debt as features expand.
