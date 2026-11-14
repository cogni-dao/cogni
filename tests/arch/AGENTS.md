# arch · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Enforces hexagonal architecture boundaries via dependency-cruiser. Tests validate that imports respect layer rules using "arch probe" pattern.

## Pointers

- [Architecture](https://node-template.cognidao.org/knowledge/hexagonal-layering-contract): hexagonal layer definitions
- [Linting Rules](https://cognidao.org/knowledge/operator-lint-toolchain): boundary enforcement migration status
- [.dependency-cruiser.cjs](../../.dependency-cruiser.cjs): boundary rules configuration

## Boundaries

```json
{
  "layer": "tests",
  "may_import": ["*"],
  "must_not_import": []
}
```

## Public Surface

- **Exports:** none
- **CLI:** `pnpm arch:check`, `pnpm arch:graph`

## Arch Probe Pattern

**What are arch probes?**

Arch probes are stub files placed in real `src/` layers (`src/{layer}/__arch_probes__/`) that demonstrate valid or invalid imports. Dependency-cruiser validates these imports during test runs.

**9 probe directories:**

- `src/core/__arch_probes__/` (7 files)
- `src/ports/__arch_probes__/` (4 files)
- `src/adapters/__arch_probes__/` (8 files)
- `src/features/__arch_probes__/` (2 files)
- `src/app/__arch_probes__/` (8 files)
- `src/bootstrap/__arch_probes__/` (8 files)
- `src/contracts/__arch_probes__/` (8 files)
- `src/components/__arch_probes__/` (1 file)
- `src/shared/__arch_probes__/` (2 files)

**Why in `src/` instead of `tests/`?**

Dependency-cruiser validates real module imports. Probes must exist in actual layers to test path resolution and boundary rules accurately.

**Probe types:**

- **Stub files**: Export dummy values (e.g., `export const AuthSession = 1;`)
- **Pass probes**: Files with valid imports (e.g., `pass_core_imports_core.ts`)
- **Fail probes**: Files with forbidden imports (e.g., `fail_core_imports_features.ts`)

**Exclusions:**

Arch probe files are excluded from:

- TypeScript compilation: `tsconfig.json` excludes `**/__arch_probes__/**`
- Production builds: Next.js build process ignores these directories

## Responsibilities

- This directory **does**: validate hexagonal architecture boundaries via dependency-cruiser, test layer import rules, replace eslint-plugin-boundaries
- This directory **does not**: test entry point enforcement (coming soon), validate runtime behavior, test application logic

## Usage

Run boundary validation:

```bash
pnpm arch:check         # validate all src/ imports against rules
pnpm arch:graph         # generate dependency graph visualization
pnpm test tests/arch/   # run all architecture boundary tests
```

Test pattern example:

```typescript
function runDepCruise(probeDirs: string[]): {
  exitCode: number;
  stderr: string;
  stdout: string;
} {
  const includeOnly = probeDirs.map((d) => `^${d}`).join("|");
  const result = spawnSync(
    "pnpm",
    [
      "depcruise",
      ...probeDirs,
      "--config",
      ".dependency-cruiser.cjs",
      "--include-only",
      includeOnly,
      "--output-type",
      "err",
    ],
    { encoding: "utf-8", cwd: process.cwd() }
  );
  return {
    exitCode: result.status ?? 1,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

// Pass test: expect exit code 0
it("allows core to import from core", () => {
  const { exitCode } = runDepCruise(["src/core/__arch_probes__"]);
  expect(exitCode).toBe(0);
});

// Fail test: expect non-zero exit code + violation message
it("blocks core from importing features", () => {
  const { exitCode, stdout } = runDepCruise([
    "src/core/__arch_probes__",
    "src/features/__arch_probes__",
  ]);
  expect(exitCode).not.toBe(0);
  expect(stdout).toContain("not-in-allowed");
});
```

## Standards

- All arch probe files must have proper TSDoc headers
- Pass tests scan only the layer being validated
- Fail tests scan both the layer and the forbidden import source
- Tests use `spawnSync` to run dependency-cruiser as subprocess
- Exit code 0 = boundaries respected, non-zero = violations found

## Migration Status

**Completed (41/59 tests):**

- ✅ Core layer (4 tests): `core-layer-boundaries.spec.ts`
- ✅ Ports layer (3 tests): `ports-layer-boundaries.spec.ts`
- ✅ App layer (7 tests): `app-layer-boundaries.spec.ts`
- ✅ Shared layer (1 test): `shared-layer-boundaries.spec.ts`
- ✅ Adapters layer (7 tests): `adapters-layer-boundaries.spec.ts`
- ✅ Contracts layer (7 tests): `contracts-layer-boundaries.spec.ts`
- ✅ Bootstrap layer (7 tests): `bootstrap-layer-boundaries.spec.ts`
- ✅ Features layer (5 tests): `features-layer-boundaries.spec.ts`

**Pending (8 tests):**

- ⏳ Entry point enforcement (8 tests): migrate from `tests/lint/eslint/entry-points.spec.ts`

**Deleted ESLint tests:**

- `tests/lint/eslint/boundaries.spec.ts` (replaced by layer-boundaries.spec.ts files)
- `tests/lint/eslint/adapters.spec.ts` (replaced by adapters-layer-boundaries.spec.ts)
- `tests/lint/eslint/contracts.spec.ts` (replaced by contracts-layer-boundaries.spec.ts)
- `tests/lint/eslint/bootstrap.spec.ts` (replaced by bootstrap-layer-boundaries.spec.ts)
- `tests/lint/eslint/features-boundaries.spec.ts` (replaced by features-layer-boundaries.spec.ts)
- `tests/lint/eslint/imports.spec.ts` (replaced by features-layer-boundaries.spec.ts)

## Dependencies

- **Internal:** all `src/` layers (via arch probes)
- **External:** `dependency-cruiser`, `vitest`, `node:child_process`

## Change Protocol

When adding new layer or boundary rules:

1. Update `.dependency-cruiser.cjs` allowed/forbidden rules
2. Create arch probe files in relevant `src/{layer}/__arch_probes__/`
3. Add test cases in corresponding `tests/arch/{layer}-layer-boundaries.spec.ts`
4. Run `pnpm arch:check` to validate configuration
5. Run `pnpm test tests/arch/` to ensure tests pass
6. Update this file's migration status
7. Bump **Last reviewed** date

## Notes

- Arch probes are test fixtures, not production code
- All probe files use minimal stub exports (e.g., `export const foo = 1;`)
- Dependency-cruiser config uses `allowedSeverity: "error"` to fail builds on violations
- ESLint boundaries plugin had 16+ false negatives; dependency-cruiser is more reliable
