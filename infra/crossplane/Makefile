# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# Top-level targets for the Crossplane Akash reconcile.

.PHONY: help test test-provider test-mock demo demo-keep

help:
	@echo "test          - unit tests: Go provider (incl. crash-safe adoption) + JS mock"
	@echo "demo          - full kind e2e: reconcile XAkashWorkload against the mock, then teardown"
	@echo "demo-keep     - same, but keep the kind cluster running for poking"

## test: run every unit test (no cluster needed).
test: test-provider test-mock

test-provider:
	cd provider-akash && go test ./... -count=1

test-mock:
	cd mock && node --test

## demo: end-to-end kind demo (unit tests + CREATE->ADOPT->DRIFT->DELETE), ZERO escrow.
demo:
	./demo.sh

demo-keep:
	KEEP_CLUSTER=1 ./demo.sh
