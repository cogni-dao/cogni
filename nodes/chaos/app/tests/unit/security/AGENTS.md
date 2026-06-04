# security · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Security-focused unit tests that enforce architectural invariants and prevent regression of security issues. Tests in this directory act as CI guards against re-introduction of known vulnerabilities or insecure patterns.

## Pointers

- [Root AGENTS.md](../../../../../AGENTS.md)
- [Security Spec](../../../../../docs/spec/security-auth.md)

## Boundaries

```json
{
  "layer": "tests",
  "may_import": ["ports", "shared", "adapters", "core"],
  "must_not_import": []
}
```

## Public Surface

**Test Files:**

- `no-secret-fields.types.test.ts` - Type-level guards ensuring secrets never appear in port interfaces (BillingAccount, LlmCaller)
- `no-key-storage-patterns.test.ts` - CI guard preventing re-introduction of key storage patterns in src/\*\* (banned patterns: litellm_virtual_key, sentinels)

**Coverage:** Port interfaces, schema definitions, adapter implementations

## File Map

- `no-secret-fields.types.test.ts` → Compile-time verification using @ts-expect-error
- `no-key-storage-patterns.test.ts` → Runtime grep-based scan of src/\*\* for banned patterns

## Responsibilities

- **Does:** Prevent security regressions via static checks; enforce "no secrets in interfaces" invariant; block key storage re-introduction.
- **Does not:** Test runtime behavior, business logic, or integration paths.

## Usage

Run security tests:

```bash
pnpm vitest run tests/unit/security/
```

Tests run automatically in CI via `pnpm check`.

## Standards

- Tests fail fast on security violations
- Patterns scanned must be kept in sync with docs/spec/security-auth.md
- Allowlists must be minimal and justified in comments

## Dependencies

- **External:** vitest, node:child_process (for grep scans)
- **Internal:** @ports (for type imports)

## Change Protocol

When adding security tests:

1. Document invariant being enforced in file header
2. Add test file to list above
3. Update SECURITY_AUTH_SPEC.md if new vulnerability class
4. Bump Last reviewed date

When security architecture changes (e.g., adding real API keys):

1. Update allowlists in guard tests
2. Add new tests for new security invariants
3. Document migration in test comments

## Notes

- Guard tests intentionally use filesystem scans (grep) to catch patterns even in generated code
- Type-level tests using @ts-expect-error provide compile-time safety
- Allowlists should reference specific migration tasks (e.g., "when real API keys are introduced")
