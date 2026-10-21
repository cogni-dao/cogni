# [Feature Name] Design

> [!CRITICAL]
> [State the most important design constraint or invariant - one sentence that defines the feature's core approach]

## Core Invariants

1. **[Invariant 1 Name]**: [Description of the first core constraint]

2. **[Invariant 2 Name]**: [Description of the second core constraint]

..

---

## Implementation Checklist

### P0: MVP Critical [Phase 0 Name]

- [ ] [Task 1 description]
- [ ] [Task 2 description]
- [ ] [Task 3 description]
- [ ] [Task 4 description]
- [ ] [Task 5 description]

#### Chores

- [ ] Observability instrumentation [observability.md](../../.agent/workflows/observability.md)
- [ ] Documentation updates `/closeout`

### P1: [Phase 1 Name]

- [ ] [Task 1 description]
- [ ] [Task 2 description]
- [ ] [Task 3 description]

### P2: [Phase 2 Name] (Optional/Future)

- [ ] [Condition to evaluate before implementing]
- [ ] [Task if condition is met]
- [ ] **Do NOT build this preemptively**

---

## File Pointers (P0 Scope)

| File                   | Change                          |
| ---------------------- | ------------------------------- |
| `src/path/to/file1.ts` | [Description of changes needed] |
| `src/path/to/file2.ts` | [Description of changes needed] |
| `src/path/to/file3.ts` | [Description of changes needed] |
| `src/path/to/file4.ts` | [Description of changes needed] |
| `src/path/to/file5.ts` | [Description of changes needed] |

---

## Schema (if needed)

**Allowed columns:**

- `column_1` (type, constraints) - [Description]
- `column_2` (type, constraints) - [Description]
- `column_3` (type, constraints) - [Description]
- `column_4` (type, constraints) - [Description]

**Forbidden columns:**

- [forbidden_field_1], [forbidden_field_2]
- [forbidden_field_3], [forbidden_field_4]
- [forbidden_field_5] ([reason])

**Why:** [Rationale for these constraints]

**[Key Property]:** [Description of implementation detail]

## Design Decisions

### 1. [Decision Area 1]

| [Column 1]   | [Column 2]        | [Column 3]      |
| ------------ | ----------------- | --------------- |
| **[Item 1]** | [Source/Location] | [Role/Behavior] |
| **[Item 2]** | [Source/Location] | [Role/Behavior] |
| **[Item 3]** | [Source/Location] | [Role/Behavior] |

**Rule:** [State the key rule or principle derived from this decision]

---

### 2. [Data/Logic Flow Area 2]

```
┌─────────────────────────────────────────────────────────────────────┐
│ [PHASE 1 NAME] (blocking/non-blocking)                             │
│ ─────────────────────────────                                       │
│ 1. [Step 1]                                                         │
│ 2. [Step 2]                                                         │
│ 3. [Step 3]                                                         │
│ 4. [Result: ALLOW or DENY]                                          │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (if condition met)
┌─────────────────────────────────────────────────────────────────────┐
│ [PHASE 2 NAME] (blocking/non-blocking)                             │
│ ───────────────────────────                                         │
│ - [Step 1]                                                          │
│ - [Step 2]                                                          │
│ - [Step 3]                                                          │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ [PHASE 3 NAME] (never blocking)                                    │
│ ─────────────────────────                                           │
│ - [Step 1]                                                          │
│ - [Step 2]                                                          │
│ - [Constraint or invariant]                                         │
└─────────────────────────────────────────────────────────────────────┘
```

**Why [this approach]?** [Rationale for the chosen design]

---

### 3. [Decision Area 3]

[Description of the decision or rule]

1. **[Case 1]**: [Action or behavior]
2. **[Case 2]**: [Action or behavior]
3. **[Case 3]**: [Action or behavior]

**Never** [anti-pattern to avoid].

---

### 4. [Decision Area 4]

**[Strategy Type 1]:**

- [Description of approach 1]
- [Key detail about approach 1]
- [Implementation note]

**[Strategy Type 2]:**

- [Description of approach 2]
- [Key detail about approach 2]
- [Implementation note]

---

**Last Updated**: YYYY-MM-DD
**Status**: [Draft | Design Approved | In Progress | Complete]
