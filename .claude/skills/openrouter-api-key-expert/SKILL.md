---
name: openrouter-api-key-expert
description: "End-to-end OpenRouter key + spend + outage playbook for Cogni. Use when investigating unexplained OpenRouter spend ('who used opus/model X?', 'why is my bill high'), a suspected leaked/compromised API key, a prod AI outage that surfaces as `provider_unavailable` / `402` / LiteLLM `Insufficient credits`, or when you must rotate/cap/kill an OpenRouter key across the fleet. Encodes the diagnostic decision tree (provider_unavailable = upstream, truth in `service=litellm` Loki; 402 = account balance dry; a model NOT in the deployed LiteLLM catalog can't come from Cogni infra), the attribution method that needs a MANAGEMENT key (/api/v1/{keys,activity,credits,key}), the rule-out-local sweep, the LiteLLM-is-Compose-on-VM + OpenBao-SSOT converge facts, the full break-glass rotation runbook (mint capped → OpenBao fleet-wide → deploy-infra converge → BEHAVIOR-verify → delete), and the CARDINAL rule: never leave a compromised key alive/uncapped — cap-or-disable on suspicion, delete the moment prod is verified on the replacement. Triggers: 'openrouter', 'who used opus', 'opus-4.8 spend', 'unexplained openrouter charges', 'leaked api key', 'compromised key', 'rotate openrouter key', 'provider_unavailable', '402 insufficient credits', 'prod AI down', 'litellm out of credits', 'openrouter activity', 'management key', 'cap the key', 'kill the leaked key', 'openrouter attribution', 'which key does prod use'."
---

# OpenRouter API Key Expert

The playbook for OpenRouter spend investigation, leak/compromise response, outage diagnosis, and fleet key rotation. Battle-tested in the 2026-08-27→31 incident (leaked prod key `cogni-template-prod-2` drained the account **twice** via direct off-infra opus-4.8 abuse → two prod AI outages). Read this BEFORE touching a key.

## 0. Prereq: you need a MANAGEMENT key (mint it, use it, revoke it)

- Inference and provisioning keys **cannot** read account attribution — `/api/v1/activity` and `/api/v1/keys` return **`403 "Only management keys can fetch activity for an account"`**. You need a **management key**.
- The **account owner** (a human with OpenRouter dashboard access) mints one at **https://openrouter.ai/settings/keys**, hands it to you to save in `.env.local` as `OPENROUTER_MANAGEMENT_KEY=` (gitignored — verify `git check-ignore .env.local`), and **revokes it the moment the job is done**. It is ephemeral break-glass custody, not a standing credential — treat it like a root token, never commit or echo it.
- Everything below that says "(mgmt)" needs it. Read it inline: `MK=$(grep -E '^OPENROUTER_MANAGEMENT_KEY=' .env.local | cut -d= -f2- | tr -d '"'"'"' \r')`.

## 1. Outage decision tree — `provider_unavailable` / 402

`provider_unavailable` is **the app correctly reporting an upstream LLM failure** (bug.5056 fix — `FAULT_PARTY_BEFORE_BUCKET`). It is NOT an app bug. The real cause lives in the **`litellm` service logs**, not the app/proxy:

```bash
scripts/loki-query.sh '{env="production",service="litellm"} |~ "(?i)(error|402|401|429|insufficient|exception)"' 20 40
```

- **`402 "Insufficient credits"`** on `openrouter.ai/api/v1/chat/completions` → the **OpenRouter ACCOUNT balance is $0**. Fix is **billing, not code/deploy**: add credits at https://openrouter.ai/settings/credits → recovers **instantly**, LiteLLM picks it up on the next request (no restart). Confirm with `curl /api/v1/credits (mgmt)` → `total_usage ≈ total_credits`. This is a per-account 402, so it 402s **every** key at once.
- **`401 "User not found"`** → the key is bad/deleted/disabled — auth, not balance. Top-up won't help; fix the key.
- **`429`** → a per-billing-account quota block at the **Cogni tenant** layer (a node/agent billing account out of Cogni credits), hit _before_ the request reaches OpenRouter — not the OpenRouter key or account. Don't chase it as a key problem.

App-side symptom (masked, for reference): `route="graphs.run.internal" error="provider_unavailable"`, `errorCode="PROVIDER_UNAVAILABLE"`, `LlmError ... status:402`. See [[project_ai_outage_openrouter_402_masked]].

## 2. Spend attribution — "who used model X?"

**Cardinal filter first:** compare the model against the **currently-deployed LiteLLM catalog** (`infra/compose/runtime/configs/litellm.config.yaml` — read it live, the roster changes). If the model is **not in that catalog** (in the incident, `opus-4.8` while the catalog topped at `opus-4.5`), it **cannot** have come from any Cogni path — LiteLLM would reject it, and there will be **zero** hits in `{service="app"|"litellm"}` Loki. That model reached OpenRouter **directly, off-infra** (leaked key or a local tool — see §3).

Then attribute with the management key:

```bash
curl -s https://openrouter.ai/api/v1/key      -H "Authorization: Bearer $MK"   # THIS key: usage, usage_daily/weekly/monthly, limit, creator_user_id, is_management_key
curl -s https://openrouter.ai/api/v1/credits   -H "Authorization: Bearer $MK"   # account: total_credits, total_usage
curl -s https://openrouter.ai/api/v1/keys      -H "Authorization: Bearer $MK"   # (mgmt) full roster: name, hash, per-key usage, disabled, limit
curl -s "https://openrouter.ai/api/v1/activity" -H "Authorization: Bearer $MK"  # (mgmt) per-DAY per-MODEL per-provider usage, ~30d window
```

- **Account-accounting by diff:** sum every key's lifetime `usage` (from `/keys`) and compare to account `/credits.total_usage`. A gap = **deleted/rotated keys** (their spend persists in the account total) — gap alone is NOT proof of a live leak.
- **Reconciliation (the money shot):** `/activity` is account-wide (per model/provider/date, **no per-key field**). Match its window total against each key's `usage_monthly` from `/keys`. In the incident, activity-window total `$37.88` == the prod key's `usage_monthly` while all other keys were `$0` monthly → **100% of recent account spend was the prod key**, of which opus-4.8 was 95%.
- **HARD LIMIT — source IP/DNS is NOT in the API.** `/activity` has no origin/IP/app field; `/api/v1/generation?id=` gives per-request origin but detail is **purged after ~24h** (returns null). The only place a caller's "app"/referer survives is the **dashboard Activity page** — and even that is at most an app tag, never a raw IP. Say this plainly; don't promise an IP the API can't give.

## 3. Rule out a LOCAL caller (before concluding "external leak")

The key value lives in `.env.production`, OpenBao, the prod cluster, **and** wherever a human/tool copied it. Sweep the machine (report paths only, never the key):

```bash
PRODKEY=<value>
grep -rlF "$PRODKEY" /Users/*/conductor/workspaces /Users/*/dev ~/.config ~/.zshrc ~/.zshenv 2>/dev/null   # Cursor file-History + deploy artifacts are common hits
grep -riE 'ANTHROPIC_BASE_URL|OPENAI_BASE_URL|OPENROUTER' ~/.zshrc ~/.claude/settings.json ~/.config 2>/dev/null   # coding-agent base-url overrides → OpenRouter
```

Coding agents (Cursor/opencode/aider/cline) can be pointed at OpenRouter with any model — a whole-repo session shows as a **huge single-day prompt-token burst** (incident Aug-20: 9 reqs, 5M prompt tokens, $26.85). If nothing local matches AND no Cogni path can emit the model → it's an **external leak of the key value**.

## 4. Architecture facts you must know before rotating

- **LiteLLM is Compose-on-VM, not a pod.** Prod svc `operator-litellm-external` is an `ExternalName` → `cogni.vm.cognidao.org:4000`. The OpenRouter call is made by the LiteLLM container reading `OPENROUTER_API_KEY` from its VM `.env`. ESO/OpenBao pod-side sync alone does **not** move the LLM path.
- **On ESO-established envs, `deploy-infra` renders the VM `.env` OPENROUTER from OpenBao, NOT the GitHub Actions secret.** `scripts/ci/deploy-infra.sh` (`OPENBAO_RUNTIME_SSOT=true` when `operator-env-secrets` exists) → `source_openbao_runtime_key required OPENROUTER_API_KEY operator ...`. The GH Actions `secrets.OPENROUTER_API_KEY` is only for bootstrap/non-ESO envs. So **OpenBao `cogni/<env>/operator` is the SSOT for the VM LiteLLM.**
- **The key is shared fleet-wide** via catalog `inheritFrom: operator` — operator's canonical value fans to EVERY inheriting node — derive the node set — `for f in infra/catalog/*.yaml; do grep -q '^type: node' $f && basename $f .yaml; done` — never a hand-typed list (Dolt `operator-node-catalog`: "the roster is LIVE STATE"). Deleting it breaks the **whole fleet's** AI, not one node. Converge all before deleting.
- **Behavior-test which key prod uses** by exercising LiteLLM from an app pod (needs account credits or you'll only see 402):
  ```bash
  POD=$(kubectl -n cogni-production get pods | grep 'operator-node-app.*Running' | head -1 | awk '{print $1}')
  kubectl -n cogni-production exec $POD -c app -- sh -c \
    'curl -s "$LITELLM_BASE_URL/v1/chat/completions" -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
     -H content-type:application/json -d "{\"model\":\"gpt-4o-mini\",\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}],\"max_tokens\":180}"'
  # then read /api/v1/key usage on old vs new key — whichever's usage MOVES is the key prod uses.
  ```

## 5. Rotation runbook

**Clean path (preferred, per `docs/guides/secrets-rotate.md`):** self-serve API `POST /api/v1/nodes/<id>/secrets {env,key:"OPENROUTER_API_KEY",value,op:"rotate"}` with `COGNI_API_KEY_<ENV>`. **A `401` = the key is expired → STOP and ask a human to refresh it; do NOT fall back to spelunking.** (In the incident `COGNI_API_KEY_PROD` was expired, forcing break-glass.)

**Break-glass (mgmt key + prod OpenBao root + kubeconfig from `~/dev/cogni-template/.local/provision-creds/production/`):**

1. **Mint the new key WITH A CAP:** `POST /api/v1/keys {name:"cogni-template-prod-N", limit:50}` (mgmt). Validate: `GET /api/v1/key` on it → 200.
2. **Write it to the SSOT fleet-wide:** `bao kv patch cogni/production/<n> OPENROUTER_API_KEY=-` for **every `type: node` catalog row** — derive the node set — `for f in infra/catalog/*.yaml; do grep -q '^type: node' $f && basename $f .yaml; done` — never a hand-typed list (Dolt `operator-node-catalog`: "the roster is LIVE STATE"). A hand-typed list here is an OUTAGE: this skill previously named 4 of 7 nodes, so a rotation following it would have left the rest holding a dead key. (via `kubectl -n openbao exec openbao-0`). Force-sync ESO: `kubectl annotate externalsecret -n cogni-production <n>-env-secrets force-sync=$(date +%s) --overwrite`.
3. **Converge the VM LiteLLM** (the ONLY way to move the actual OpenRouter caller): dispatch `promote-and-deploy.yml` for prod with `skip_infra=false deploy_infra_mode=full`, **pinned to the CURRENT prod sha** (`curl https://cognidao.org/version` → `source_sha`+`build_sha`) so the app does NOT roll. Note the input is **`deploy_infra_mode`** on main (not `infra_mode`). It runs on the VM self-hosted runner (why laptop SSH is a dead end). A **`deploy-infra` "failure" is usually a premature LiteLLM readiness timeout** during container recreate — verify in Loki that LiteLLM actually came back (`Started server process` → `readiness 200`) before treating it as a real failure.
4. **BEHAVIOR-verify** prod is on the new key: fire a completion (§4) and confirm the **new** key's `usage` moves and the old key's does NOT. Deploy-proof ≠ function.
5. **Delete the old key** (mgmt `DELETE /api/v1/keys/{hash}`) only after step 4 passes.

## 6. CARDINAL cleanup rule (the lesson that cost a weekend)

**Never leave a compromised/leaked key alive or uncapped "temporarily."** The moment you suspect compromise:

- **Immediately** `PATCH {disabled:true}` (reversible) or cap to ~$1/day. Do NOT "raise the cap so users can use" on a _leaked_ key — mint the new key for that.
- **Finish the rotation in ONE session.** A disabled-but-not-deleted or (worse) uncapped leaked key WILL be abused. In this incident the leaked key was left **uncapped over a weekend** → external opus abuse re-drained the account → **second prod outage**. Half-done is worse than not-started.
- **Cap the live prod key** at a generous monthly limit (`{limit:50,limit_reset:"monthly"}`, ~25× MVP usage) as **account-insurance** — OpenRouter has **no per-key model allowlist**, so a spend cap is the only bound against a future leak draining the whole balance. Bump it when onboarding a paying user.
- Purge stale copies (Cursor `~/Library/Application Support/Cursor/User/History/*.production`, `.context` deploy artifacts) — though a **deleted** key value is already inert.

## Related

- [[project_ai_outage_openrouter_402_masked]] — the 402-masking + `FAULT_PARTY_BEFORE_BUCKET` fix (bug.5056).
- [[reference_openrouter_preview_rotation]] — the LiteLLM-Compose-on-VM `.env` converge recipe (preview; same shape for prod).
- `docs/guides/secrets-rotate.md` — the clean self-serve rotation lane + the `401 = STOP` rule.
- `scripts/ci/deploy-infra.sh` (`source_openbao_runtime_key`) — proof the VM `.env` renders OPENROUTER from OpenBao SSOT.
- `.claude/skills/cicd-secrets-expert/` — OpenBao/ESO custody + `pnpm secrets:set` lanes.
