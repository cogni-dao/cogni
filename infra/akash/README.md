# infra/akash — Akash deployment surface

Akash workload provisioning shipped v1 as **typed TS control plane**, not manifests here
(task.5044): `AkashComputeAdapter` (`nodes/operator/app/src/adapters/server/compute/`)
implements the write half of `ComputeResourcePort` over the Akash Console managed-wallet
API, rendering SDL internally from the provider-agnostic `ProvisionSpec`
(`adapters/server/compute/akash-sdl.ts`). Node apps ship only through `POST /api/v1/deploy/workloads` (the node-deploy sequencer).

This directory remains the future home of a catalog-driven SDL renderer (reads
`infra/catalog/*.yaml`, emits SDL, peer of `infra/k8s/`) if/when per-node Akash
placement becomes a catalog field.

See `infra/provision/akash/FUTURE_AKASH_INTEGRATION.md` for the crypto-native
(self-custody) funding path — deferred; v0 bills the shared operator Console account in USD.
