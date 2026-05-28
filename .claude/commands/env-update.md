---
description: Guide for propagating environment variables across the stack
---

You've just added or changed an environment variable. To ensure it propagates correctly across local development, test/runtime containers, CI/CD, and deployed environments, you must update multiple files.

Use this checklist to verify you haven't missed anything.

## 0. First classify the variable

- [ ] **Is it required or optional?** If optional, make sure the runtime path preserves "unset" rather than writing an empty string.
- [ ] **Is it local-only, CI-only, runtime-only, or all three?** Don't cargo-cult every surface.
- [ ] **Is it a secret or plain config?** Secrets usually belong in GitHub Environment Secrets or repo secrets, not committed `.env` files.
- [ ] **Write down how an operator gets the value.** "Add env var" is incomplete without "from where?"

## 1. Validation & Types (The Source of Truth)

- [ ] **`nodes/*/app/src/shared/env/server-env.ts`** (or the relevant runtime env schema): Add the variable to the Zod schema. This ensures type safety and runtime validation.
- [ ] **Other runtimes**: If the variable is also used by another isolated runtime, update that env schema too (for example a worker/bootstrap-specific schema).

## 2. Local Development & Documentation

- [ ] **`.env.local`**: Add the variable with a real value for this local environment if you need to exercise it locally. This file is often untracked.
- [ ] **`.env.test`**: Add the variable only if this repo/runtime actually uses a checked-in `.env.test`.
- [ ] **`.env.local.example`** (and `.env.test.example` if present): Add the variable with a placeholder or default value. This is the public documentation for required env vars.
- [ ] **Nearest operator/developer guide**: Update the most relevant guide with where to source the value. Example: Privy vars belong in a Privy setup guide, not only in `.env.local.example`.

## 3. Docker Compose (Runtime Stack)

If the variable is needed by the main application container:

- [ ] **`infra/compose/runtime/docker-compose.dev.yml`**: Add it to the `environment` section of the `app` service.
- [ ] **`infra/compose/runtime/docker-compose.yml`**: Add it to the `environment` section of the `app` service.

If the variable is needed by other services:

- [ ] **`infra/compose/runtime/docker-compose.yml`**: For Caddy/Edge variables (rare).

## 4. CI Pipeline (Tests)

- [ ] **`.github/workflows/ci.yaml`**: Add the variable only to the jobs that need it.
      If the env schema treats it as required during test boot, add a test-safe value to every relevant job block.
      If the env schema treats it as optional and tests do not exercise it, you usually do not need to inject it.

## 5. Deployment Pipeline (Production/Preview)

To get the variable from GitHub secrets/vars into the deployed runtime:

### A. GitHub Workflows

- [ ] **`.github/workflows/candidate-flight-infra.yml`**: Map the secret/var into the workflow `env` block for candidate-a infra deploys.
- [ ] **`.github/workflows/promote-and-deploy.yml`**: Map the secret/var into the `deploy-infra` job `env` block for preview/production deploys.
- [ ] **`scripts/setup-secrets.ts`**: Add the secret to the `SECRETS` catalog with category + steps + (if agent-generated) a `generate` fn. This is how operators provision GH Environment Secrets — without it the secret silently goes missing on fresh setup. Run `pnpm setup:secrets --only <NAME>` to actually push it.
- [ ] **GitHub UI** (or `pnpm setup:secrets`): Ensure the value is actually created in the right GitHub Environment Secrets or Variables scope (`candidate-a`, `preview`, `production`, or repo-level as appropriate).

### B. Deployment Script (`deploy-infra.sh`) — 3 places!

**CRITICAL**: Missing any one of these causes silent empty values in production.

- [ ] **`scripts/ci/deploy-infra.sh`**:
  1.  Add it to `REQUIRED_SECRETS` (if it's a secret), `OPTIONAL_SECRETS` (if optional), or `REQUIRED_ENV_VARS` (if it's a config).
  2.  Add it to the `cat > "$RUNTIME_ENV"` heredoc (required vars) or via `append_env_if_set` (optional vars) in the Step 1 block.
  3.  Add it to the `ssh ... bash /tmp/deploy-infra-remote.sh` command at the bottom of the file to pass it into the remote script's environment. Use `'${VAR:-}'` quoting for optional vars.

## 6. Setup Documentation (CRITICAL)

- [ ] **`scripts/setup/SETUP_DESIGN.md`**: Add the variable to the relevant secrets list so future fresh-clone setups know to provision it. Without this, new environments will silently miss the variable.

## 7. Operator Setup Docs (Easy To Miss)

- [ ] **Operator-facing setup guide**: If someone needs to click through a vendor dashboard to obtain this value, update the nearest setup guide with:
  1. Where in the vendor UI to find or create it
  2. Whether it is app-scoped, wallet-scoped, or per-environment
  3. Whether it is safe to reuse or must be distinct from an existing value
  4. Where it belongs locally vs in GitHub Environment Secrets

Example:

- Privy app credentials belong in `docs/guides/operator-wallet-setup.md` or the nearest Polymarket/Privy setup guide.

## 8. Special Cases: Isolated Services

If the variable is for a standalone service running in its own Docker Compose project:

- [ ] **Docker Compose**: Update the service's compose file.
- [ ] **`deploy-infra.sh` (Step 1)**: Add the variable to the specific `.env` file generation block for that service.
- [ ] **`deploy-infra.sh` (Compose Command)**: **CRITICAL**: Ensure the `docker compose` command for that service explicitly uses `--env-file /path/to/service/.env`.
  - _Reason_: Isolated services often run from a shared script context and won't automatically find their `.env` file unless explicitly told.

## 9. Sanity Pass

- [ ] Run a quick grep for the variable name across the repo and make sure every intended surface is covered.
- [ ] If you touched a shell deploy script, run `bash -n` on it.
- [ ] If you touched YAML/Markdown/compose files, run formatting or at least a syntax sanity check.

## Reference

- [scripts/setup/SETUP_DESIGN.md](scripts/setup/SETUP_DESIGN.md): Full setup design including all secret provisioning lists.
