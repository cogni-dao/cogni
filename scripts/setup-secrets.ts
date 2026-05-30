#!/usr/bin/env npx tsx
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@scripts/setup-secrets`
 * Purpose: Interactive secret provisioning for Cogni node formation.
 * Scope: Walks through all GitHub Actions secrets (preview + production), auto-generates agent-rotatable values, prompts for human-provided ones with dashboard URLs; does not modify code or deploy.
 * Invariants: Secrets set per-env only. Agent secrets use openssl rand.
 * Side-effects: IO (sets GitHub Actions secrets via gh secret set)
 * Links: docs/runbooks/SECRET_ROTATION.md
 *
 * Usage:
 *   pnpm setup:secrets                        # walk through missing secrets (all envs)
 *   pnpm setup:secrets --env candidate-a      # only candidate-a environment
 *   pnpm setup:secrets --env candidate-a --all # candidate-a, including already-set
 *   pnpm setup:secrets --env candidate-a --auto # auto-generate missing agent secrets, only prompt for human ones
 *   pnpm setup:secrets --poly                 # only poly-related secrets (all envs)
 *   pnpm setup:secrets --poly --env candidate-a # only poly secrets for candidate-a
 *   pnpm setup:secrets:poly --env candidate-a # same poly-only flow via package.json alias
 *   pnpm setup:secrets --required             # only required secrets
 *   pnpm setup:secrets --all                  # walk through everything (including already-set)
 *   pnpm setup:secrets --only DISCORD         # just secrets matching "DISCORD"
 *   pnpm setup:secrets --only DISCORD,SONAR   # multiple patterns (comma-separated)
 */

import { execSync } from "node:child_process";
import * as readline from "node:readline";
import { loadSecretsCatalog, type Secret } from "./lib/secrets-catalog-loader";

// Types are imported from the loader. See docs/spec/secrets-classification.md
// for tier definitions and docs/design/secrets-catalog-per-node.md for the
// rationale on why catalog data lives in YAML rather than this file.

// ── Catalog loader ──────────────────────────────────────────────────────────
//
// Per-secret data lives in YAML (node-domain or operator-domain). The loader
// walks `nodes/*/.cogni/secrets-catalog.yaml` + `infra/secrets-catalog.yaml`,
// validates via Zod, asserts uniqueness, and emits the Secret[] + routing
// shapes the rest of this file consumes. See:
//   - docs/spec/secrets-classification.md (tier definitions + rules)
//   - docs/design/secrets-catalog-per-node.md (file-layout rationale)
//
// REPO constant below is hardcoded to "Cogni-DAO/cogni" — this script today
// targets the cogni-template org for secret writes regardless of which fork
// hosts the source tree. Fork-aware REPO resolution is a separate task.

const REPO_ROOT = execSync("git rev-parse --show-toplevel", {
  encoding: "utf-8",
}).trim();

const { secrets: SECRETS, routing: SECRET_ROUTING } = loadSecretsCatalog({
  repoRoot: REPO_ROOT,
});

// SSH_DEPLOY_KEY's value is generated per-env at write time. The catalog
// marks the entry with `generate: { kind: ssh-key }`; actual key minting
// happens here because the value is env-bound and the main loop special-cases
// SSH_DEPLOY_KEY (one key per environment, public-key footer printed).
function generateSSHKey(env: string): string {
  const path = `/tmp/cogni-deploy-key-${env}-${Date.now()}`;
  execSync(
    `ssh-keygen -t ed25519 -f ${path} -N "" -C "cogni-deploy-${env}-$(date +%Y%m%d)" -q`
  );
  const privKey = execSync(`cat ${path}`).toString();
  const pubKey = execSync(`cat ${path}.pub`).toString().trim();
  execSync(`rm -f ${path} ${path}.pub`);
  console.log("");
  console.log(`     Public key for ${env}:`);
  console.log(`     ${pubKey}`);
  console.log("");
  console.log(
    `     Save this to: infra/provision/cherry/base/keys/cogni_template_${env}_deploy.pub`
  );
  console.log(`     Then run: tofu apply -var-file=terraform.${env}.tfvars`);
  console.log("");
  return privKey;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const REPO = "Cogni-DAO/cogni";
/** Deploy environments. Secrets are set per-env, not repo-level. */
const ENVIRONMENTS = ["candidate-a", "preview", "production"] as const;
const LEGACY_ENV_ALIASES: Record<string, (typeof ENVIRONMENTS)[number]> = {
  canary: "candidate-a",
};

/** Track secret values per environment for .env file generation */
const envSecretValues: Record<
  string,
  Record<string, string>
> = Object.fromEntries(ENVIRONMENTS.map((env) => [env, {}]));

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

function envStatus(has: boolean): string {
  return has ? `${GREEN}set${RESET}` : `${RED}missing${RESET}`;
}

function getSetSecrets(env: string): Set<string> {
  try {
    const out = execSync(
      `gh secret list --repo ${REPO} --env ${env} 2>/dev/null`,
      {
        encoding: "utf-8",
      }
    );
    return new Set(
      out
        .split("\n")
        .map((l) => l.split("\t")[0])
        .filter(Boolean)
    );
  } catch {
    console.error(
      `Failed to list secrets for ${env}. Is \`gh\` authenticated?`
    );
    process.exit(1);
  }
}

function setSecret(name: string, value: string, env: string): boolean {
  try {
    execSync(`gh secret set ${name} --repo ${REPO} --env ${env}`, {
      input: value,
      encoding: "utf-8",
    });
    // Track for .env file generation
    const envSecrets = envSecretValues[env];
    if (envSecrets) {
      envSecrets[name] = value;
    }
    return true;
  } catch (e) {
    console.error(`  Failed to set ${name} (${env}): ${e}`);
    return false;
  }
}

function setSecretBoth(
  name: string,
  value: string,
  envs: readonly string[] = ENVIRONMENTS
): boolean {
  let ok = true;
  for (const env of envs) {
    if (!setSecret(name, value, env)) ok = false;
  }
  return ok;
}

function setSecretRepo(name: string, value: string): boolean {
  try {
    execSync(`gh secret set ${name} --repo ${REPO}`, {
      input: value,
      encoding: "utf-8",
    });
    return true;
  } catch (e) {
    console.error(`  Failed to set ${name} (repo): ${e}`);
    return false;
  }
}

function getRepoSecrets(): Set<string> {
  try {
    const out = execSync(`gh secret list --repo ${REPO} 2>/dev/null`, {
      encoding: "utf-8",
    });
    return new Set(
      out
        .split("\n")
        .map((l) => l.split("\t")[0])
        .filter(Boolean)
    );
  } catch {
    console.error("Failed to list repo secrets. Is `gh` authenticated?");
    process.exit(1);
  }
}

async function prompt(
  rl: readline.Interface,
  question: string
): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

/** Apply secret.transform if defined, otherwise return as-is */
function applyTransform(secret: Secret, value: string): string {
  const v = value.trim();
  return secret.transform ? secret.transform(v) : v;
}

/**
 * Categorize a secret as belonging to a specific node (--node <name> filter).
 * Routing-driven: a secret belongs to <node> iff its OpenBao service is
 *   - the node name itself (A1/A2 entries the node owns), OR
 *   - `_shared` (cross-service A1 entries the node also needs), OR
 *   - `_system` (G-tier derived entries — node-list dependent and provisioned
 *     alongside any node's catalog).
 *
 * Excludes operator-domain B/D/E entries (no service in OpenBao; Compose-infra
 * and CI-only). Replaces the legacy hardcoded `isPolySecret`.
 */
function isNodeSecret(secret: Secret, nodeName: string): boolean {
  const r = SECRET_ROUTING[secret.name];
  return (
    r?.service === nodeName ||
    r?.service === "_shared" ||
    r?.service === "_system"
  );
}

// ── Database DSN helpers ─────────────────────────────────────────────────────

const dbPasswords: Record<string, string> = {};

function buildDSNs(envs: readonly string[]): void {
  const appUser = dbPasswords.APP_DB_USER || "app_user";
  const appPw = dbPasswords.APP_DB_PASSWORD;
  const svcUser = dbPasswords.APP_DB_SERVICE_USER || "app_service";
  const svcPw = dbPasswords.APP_DB_SERVICE_PASSWORD;
  const dbName = dbPasswords.APP_DB_NAME || "cogni_template";
  const host = "postgres"; // Docker service name

  if (appPw) {
    const url = `postgresql://${appUser}:${appPw}@${host}:5432/${dbName}`;
    setSecretBoth("DATABASE_URL", url, envs);
    console.log(`  ${GREEN}DATABASE_URL${RESET} set (${envs.join(", ")})`);
  }
  if (svcPw) {
    const url = `postgresql://${svcUser}:${svcPw}@${host}:5432/${dbName}`;
    setSecretBoth("DATABASE_SERVICE_URL", url, envs);
    console.log(
      `  ${GREEN}DATABASE_SERVICE_URL${RESET} set (preview + production)`
    );
  }
}

// ── Display ──────────────────────────────────────────────────────────────────
// (printInventory removed — inventory now rendered inline in main() using targetEnvs)

function printSecretHeader(
  secret: Secret,
  envSets: Record<string, Set<string>>,
  repoSecrets: Set<string>,
  envNames: readonly string[]
): void {
  const reqTag = secret.required
    ? `${BOLD}[REQUIRED]${RESET}`
    : `${DIM}[optional]${RESET}`;

  console.log("");
  const statusLine = secret.repoLevel
    ? `[repo: ${envStatus(repoSecrets.has(secret.name))}]`
    : `[${envNames.map((e) => `${e}: ${envStatus(envSets[e]?.has(secret.name) ?? false)}`).join(", ")}]`;
  console.log(`  ${reqTag} ${BOLD}${secret.name}${RESET}  ${statusLine}`);
  console.log(`  ${secret.description}`);

  if (secret.url) {
    console.log("");
    console.log(`     ${CYAN}${secret.url}${RESET}`);
    console.log("");
  }

  for (const step of secret.steps) {
    console.log(`     ${step}`);
  }
  console.log("");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const showAll = args.includes("--all");
  // --node <name> filters to one node's catalog entries (poly, resy, …).
  // Legacy alias: --poly maps to --node poly.
  const nodeArg =
    args.find((a) => a.startsWith("--node="))?.slice(7) ||
    (args.includes("--node") ? args[args.indexOf("--node") + 1] : undefined);
  const polyOnly = args.includes("--poly");
  const nodeFilter = nodeArg ?? (polyOnly ? "poly" : undefined);
  const filterRequired = args.includes("--required");
  const autoGenerate = args.includes("--auto");
  // --only DISCORD,SONAR  or  --only DISCORD_OAUTH_CLIENT_ID
  const onlyArg =
    args.find((a) => a.startsWith("--only="))?.slice(7) ||
    (args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined);
  const onlyPatterns = onlyArg
    ?.split(",")
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);

  // --env canary  or  --env=canary  (target a single environment)
  const rawEnvArg =
    args.find((a) => a.startsWith("--env="))?.slice(6) ||
    (args.includes("--env") ? args[args.indexOf("--env") + 1] : undefined);
  const envArg = rawEnvArg
    ? (LEGACY_ENV_ALIASES[rawEnvArg] ?? rawEnvArg)
    : undefined;
  const targetEnvs: (typeof ENVIRONMENTS)[number][] = envArg
    ? [envArg as (typeof ENVIRONMENTS)[number]]
    : [...ENVIRONMENTS];

  if (
    envArg &&
    !ENVIRONMENTS.includes(envArg as (typeof ENVIRONMENTS)[number])
  ) {
    console.error(
      `Unknown environment: ${envArg}. Must be one of: ${ENVIRONMENTS.join(", ")}`
    );
    process.exit(1);
  }

  if (rawEnvArg === "canary") {
    console.log(
      `  ${YELLOW}Legacy alias detected:${RESET} canary -> candidate-a\n`
    );
  }

  if (envArg) {
    console.log(`  ${CYAN}Targeting environment: ${envArg}${RESET}\n`);
  }
  if (nodeFilter) {
    console.log(
      `  ${CYAN}Node filter:${RESET} only secrets routed to service=${nodeFilter}\n`
    );
  }

  // Fetch current secret status for target environments
  const envSecretSets: Record<string, Set<string>> = {};
  for (const env of targetEnvs) {
    envSecretSets[env] = getSetSecrets(env);
  }
  const repoSecrets = getRepoSecrets();
  const inventorySecrets = nodeFilter
    ? SECRETS.filter((s) => isNodeSecret(s, nodeFilter))
    : SECRETS;

  // Print inventory for target environments only
  console.log(
    `\n${BOLD}  Secret Inventory${nodeFilter ? ` (${nodeFilter})` : ""} — ${REPO} (${targetEnvs.join(", ")})${RESET}\n`
  );
  console.log(
    `  ${"SECRET".padEnd(42)} ${"LEVEL".padEnd(8)} ${"STATUS".padEnd(22)} ${"SOURCE"}`
  );
  console.log(
    `  ${"─".repeat(42)} ${"─".repeat(8)} ${"─".repeat(22)} ${"─".repeat(8)}`
  );
  let lastCat = "";
  for (const s of inventorySecrets) {
    if (s.category !== lastCat) {
      console.log(`\n  ${DIM}${s.category}${RESET}`);
      lastCat = s.category;
    }
    const req = s.required ? "" : `${DIM}(opt)${RESET} `;
    const src =
      s.source === "agent" ? `${DIM}auto${RESET}` : `${YELLOW}human${RESET}`;
    if (s.repoLevel) {
      const rStatus = envStatus(repoSecrets.has(s.name));
      console.log(
        `  ${req}${s.name.padEnd(s.required ? 42 : 37)} ${DIM}repo${RESET}     ${rStatus.padEnd(31)} ${src}`
      );
    } else {
      const statuses = targetEnvs
        .map((e) => `${e}:${envStatus(envSecretSets[e]?.has(s.name) ?? false)}`)
        .join(" ");
      console.log(
        `  ${req}${s.name.padEnd(s.required ? 42 : 37)} ${DIM}env${RESET}      ${statuses}  ${src}`
      );
    }
  }
  console.log("");

  let filtered = inventorySecrets;
  if (onlyPatterns) {
    filtered = filtered.filter((s) =>
      onlyPatterns.some((p) => s.name.includes(p))
    );
  } else {
    if (filterRequired) {
      filtered = filtered.filter((s) => s.required);
    }
    if (!showAll) {
      filtered = filtered.filter((s) => {
        if (s.repoLevel) return !repoSecrets.has(s.name);
        // Show if missing in ANY target environment
        return targetEnvs.some((e) => !envSecretSets[e]?.has(s.name));
      });
    }
  }

  if (filtered.length === 0) {
    console.log(
      `  ${GREEN}All secrets are set for ${targetEnvs.join(", ")}.${RESET}`
    );
    console.log(`  Run with --all to walk through everything.\n`);
    return;
  }

  console.log(
    `  ${filtered.length} secret(s) to configure. Press Enter to skip any.\n`
  );
  console.log(`  ${"─".repeat(70)}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let set = 0;
  let skipped = 0;
  let lastCategory = "";

  for (const secret of filtered) {
    if (secret.category !== lastCategory) {
      console.log(
        `\n${"═".repeat(2)} ${BOLD}${secret.category}${RESET} ${"═".repeat(60 - secret.category.length)}`
      );
      lastCategory = secret.category;
    }

    printSecretHeader(secret, envSecretSets, repoSecrets, targetEnvs);

    // SSH_DEPLOY_KEY is special — one key per environment
    if (secret.name === "SSH_DEPLOY_KEY") {
      const missingEnvs = targetEnvs.filter(
        (e) => !envSecretSets[e]?.has(secret.name)
      );
      if (missingEnvs.length === 0) {
        console.log(`  ${DIM}SSH_DEPLOY_KEY — already set, skipping${RESET}`);
        skipped++;
        continue;
      }
      if (!autoGenerate) {
        const action = await prompt(
          rl,
          `  Generate SSH keys for ${missingEnvs.join(", ")}? [Y/n] `
        );
        if (action.toLowerCase() === "n") {
          skipped++;
          continue;
        }
      }
      for (const env of missingEnvs) {
        // Reuse existing key from .local/{env}-vm-key if available (matches what's on that env's VM)
        const repoRoot = execSync("git rev-parse --show-toplevel", {
          encoding: "utf-8",
        }).trim();
        const localKeyPath = `${repoRoot}/.local/${env}-vm-key`;
        const { existsSync, readFileSync } = require("node:fs");
        let privKey: string;
        if (existsSync(localKeyPath)) {
          privKey = readFileSync(localKeyPath, "utf-8");
          console.log(
            `  ${DIM}Using existing key from .local/${env}-vm-key${RESET}`
          );
        } else {
          privKey = generateSSHKey(env);
        }
        setSecret(secret.name, privKey, env);
        console.log(`  ${GREEN}SSH_DEPLOY_KEY${RESET} set for ${env}`);
      }
      set++;
      continue;
    }

    // Repo-level secrets (CI, not deploy)
    if (secret.repoLevel) {
      const value = await prompt(
        rl,
        `  Paste value for ${BOLD}repo${RESET} (Enter to skip): `
      );
      if (!value.trim()) {
        skipped++;
        continue;
      }
      const final = applyTransform(secret, value);
      if (setSecretRepo(secret.name, final)) {
        if (final !== value.trim())
          console.log(`  ${DIM}(transformed: ${final})${RESET}`);
        console.log(`  ${GREEN}${secret.name}${RESET} set (repo-level)`);
        set++;
      }
      continue;
    }

    if (secret.source === "agent") {
      // --auto: skip prompt, auto-generate missing agent secrets
      if (autoGenerate) {
        // Only set if missing in at least one target env
        const missing = targetEnvs.some(
          (e) => !envSecretSets[e]?.has(secret.name)
        );
        if (!missing) {
          console.log(`  ${DIM}${secret.name} — already set, skipping${RESET}`);
          skipped++;
          continue;
        }
        const value = secret.generate?.();
        // Only set for envs where it's missing
        const envsToSet = targetEnvs.filter(
          (e) => !envSecretSets[e]?.has(secret.name)
        );
        if (setSecretBoth(secret.name, value, envsToSet)) {
          console.log(
            `  ${GREEN}${secret.name}${RESET} generated + set (${envsToSet.join(", ")})`
          );
          set++;
          if (secret.category === "Database") {
            dbPasswords[secret.name] = value;
          }
        }
      } else {
        const action = await prompt(
          rl,
          `  Generate and set for ${targetEnvs.join(", ")}? [Y/n] `
        );
        if (action.toLowerCase() === "n") {
          skipped++;
          continue;
        }
        const value = secret.generate?.();
        if (setSecretBoth(secret.name, value, targetEnvs)) {
          console.log(
            `  ${GREEN}${secret.name}${RESET} set (${targetEnvs.join(", ")})`
          );
          set++;
          if (secret.category === "Database") {
            dbPasswords[secret.name] = value;
          }
        }
      }
    } else if (secret.perEnv) {
      // Per-env human secrets (DOMAIN, VM_HOST) — ask for each env separately
      for (const env of targetEnvs) {
        const already = envSecretSets[env]?.has(secret.name) ?? false;
        if (already && !showAll) continue;
        const value = await prompt(
          rl,
          `  Value for ${BOLD}${env}${RESET} (Enter to skip): `
        );
        if (!value.trim()) continue;
        const final = applyTransform(secret, value);
        if (final !== value.trim())
          console.log(`  ${DIM}(transformed: ${final})${RESET}`);
        if (setSecret(secret.name, final, env)) {
          console.log(`  ${GREEN}${secret.name}${RESET} set for ${env}`);
          set++;
        }
      }
    } else {
      // Human secrets — ask per-environment
      // Determine which target envs are missing this secret
      const missingEnvs = targetEnvs.filter(
        (e) => !envSecretSets[e]?.has(secret.name)
      );

      if (missingEnvs.length === 0 && !showAll) {
        skipped++;
        continue;
      }

      const envsToSet = missingEnvs.length > 0 ? missingEnvs : targetEnvs;
      if (missingEnvs.length > 0 && missingEnvs.length < targetEnvs.length) {
        console.log(`  ${DIM}(missing in ${missingEnvs.join(", ")})${RESET}`);
      }

      // Prompt for each environment
      let didSet = false;
      for (const env of envsToSet) {
        const value = await prompt(
          rl,
          `  Paste value for ${BOLD}${env}${RESET} (Enter to skip): `
        );
        if (!value.trim()) continue;
        const final = applyTransform(secret, value);
        if (final !== value.trim())
          console.log(`  ${DIM}(transformed: ${final})${RESET}`);
        if (setSecret(secret.name, final, env)) {
          console.log(`  ${GREEN}${secret.name}${RESET} set for ${env}`);
          didSet = true;
        }
      }
      if (didSet) set++;
      else skipped++;
    }
  }

  // Build DATABASE_URL and DATABASE_SERVICE_URL from collected passwords
  if (dbPasswords.APP_DB_PASSWORD || dbPasswords.APP_DB_SERVICE_PASSWORD) {
    console.log(
      `\n${"═".repeat(2)} ${BOLD}Derived Database URLs${RESET} ${"═".repeat(41)}`
    );
    buildDSNs(targetEnvs);
  }

  // Write .env.{env} files for each environment that had secrets set
  const repoRoot = execSync("git rev-parse --show-toplevel", {
    encoding: "utf-8",
  }).trim();

  for (const env of targetEnvs) {
    const secrets = envSecretValues[env];
    if (!secrets || Object.keys(secrets).length === 0) continue;

    const envFile = `${repoRoot}/.env.${env}`;
    const { readFileSync, writeFileSync, chmodSync, existsSync } = await import(
      "node:fs"
    );

    // Merge with existing .env file — never lose previously set values
    const existing: Record<string, string> = {};
    if (existsSync(envFile)) {
      const content = readFileSync(envFile, "utf-8");
      for (const line of content.split("\n")) {
        if (line.startsWith("#") || !line.includes("=")) continue;
        const eqIdx = line.indexOf("=");
        const key = line.slice(0, eqIdx);
        let val = line.slice(eqIdx + 1);
        if (val.startsWith("'") && val.endsWith("'")) {
          val = val.slice(1, -1).replace(/'\\'''/g, "'");
        }
        if (/^[A-Z_][A-Z0-9_]*$/.test(key)) {
          existing[key] = val;
        }
      }
    }

    const merged = { ...existing, ...secrets };
    const lines = [
      `# setup-secrets.ts — ${new Date().toISOString()}`,
      `# Source of truth for ${env} environment secrets.`,
      `# Read by: provision-test-vm.sh, deploy-infra.sh (via GitHub env)`,
      `# DO NOT commit this file (gitignored).`,
      "",
      ...Object.entries(merged).map(
        ([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`
      ),
      "",
    ];
    writeFileSync(envFile, lines.join("\n"));
    chmodSync(envFile, 0o600);
    console.log(
      `  ${GREEN}Saved${RESET} .env.${env} (${Object.keys(merged).length} total, ${Object.keys(secrets).length} new/updated)`
    );
  }

  console.log(
    `\n  Done. ${GREEN}${set} set${RESET}, ${DIM}${skipped} skipped${RESET}.\n`
  );
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
