# AGENTS.md — Your Cogni Node

> This repo is a **Cogni node** minted from `node-template`. It is a sovereign
> repo: your code lives and is built here, in its own git boundary. A shared
> **operator** monorepo pins this repo as a submodule and runs the deploy/infra
> plane for you — you never edit the operator's `infra/catalog`, run
> `provision-env`, or touch Argo. See `docs/spec/node-ci-cd-contract.md` in the
> operator monorepo for the full two-views model.

## What you own (node-dev half)

- **App + graphs + packages** at the repo root.
- **Your CI** (`.github/workflows/`), policy (`biome`, `tsconfig`, `.dependency-cruiser.cjs`), and `Dockerfile` — `POLICY_STAYS_LOCAL`. Your CI builds + pushes your own image (`FORK_FREEDOM`).
- **Review policy**: `.cogni/repo-spec.yaml` `gates:` + `.cogni/rules/`. A PR here routes + reviews against these (born-reviewable). Tune the gate set to your node's mission.

## Add a secret (node-dev half)

Declare the key's **shape** in `.cogni/secrets-catalog.yaml` and consume it via typed env in app code (fail-fast if missing). You do **not** set the value or wire the ExternalSecret — whoever owns the deploy env does that (`pnpm secrets:set <env> <slug> <KEY>`).

## Add a service (node-dev half)

App code + `Dockerfile` + a k8s **base** manifest + the **build→GHCR** workflow leg, all here. Your CI builds + pushes the image. The operator's plane generates the per-env overlay/AppSet/catalog row that references your pushed digest.

> The full operator-side guides (`create-service`, `secrets-add-new`) live in the
> operator monorepo and are the reference for the deploy-env half.
