#!/usr/bin/env bash
# render-sdl.sh  → stdout: a concrete SDL for the deployment.
#
# TODAY: fills the template examples/node.sdl.yaml from env (self-contained, no
# dependency on unmerged code).
#   NODE_IMAGE=nginx:1.27-alpine NODE_PORT=80 scripts/akash/render-sdl.sh > artifacts/deploy.yaml
#
# POST-2077: replace the body below with a call into buildAkashSdl(
#   buildNodeWorkloadSpec(...)) from @cogni/operator so the crypto rail deploys
# the identical workload the managed adapter does. Tracked in
# docs/guides/akash-crypto-deploy.md ("SDL: template now, renderer later").
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

NODE_IMAGE="${NODE_IMAGE:-nginx:1.27-alpine}"
NODE_PORT="${NODE_PORT:-80}"
export NODE_IMAGE NODE_PORT

tmpl="$(dirname "${BASH_SOURCE[0]}")/examples/node.sdl.yaml"
# Only substitute the two known placeholders; leave all other $ untouched.
sed -e "s|\${NODE_IMAGE}|${NODE_IMAGE}|g" -e "s|\${NODE_PORT}|${NODE_PORT}|g" "$tmpl"
