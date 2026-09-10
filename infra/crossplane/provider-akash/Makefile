# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# provider-akash build/test/package targets.

IMG            ?= ghcr.io/cogni-dao/provider-akash:v0.1.0
XPKG           ?= ghcr.io/cogni-dao/provider-akash:v0.1.0
PLATFORM       ?= linux/amd64
CONTROLLER_GEN_VERSION ?= v0.18.0
BIN            := $(CURDIR)/bin
CONTROLLER_GEN := $(BIN)/controller-gen

.PHONY: all
all: generate vet test build

$(CONTROLLER_GEN):
	GOBIN=$(BIN) go install sigs.k8s.io/controller-tools/cmd/controller-gen@$(CONTROLLER_GEN_VERSION)

## generate: regenerate deepcopy methods and CRDs from the API types.
.PHONY: generate
generate: $(CONTROLLER_GEN)
	$(CONTROLLER_GEN) object paths=./apis/...
	$(CONTROLLER_GEN) "crd:allowDangerousTypes=true" paths=./apis/... output:crd:artifacts:config=package/crds
	gofmt -w ./apis ./internal ./cmd

## vet: static analysis.
.PHONY: vet
vet:
	go vet ./...

## test: unit tests (includes the crash-safe adoption proof).
.PHONY: test
test:
	go test ./... -count=1

## test-v: verbose unit tests.
.PHONY: test-v
test-v:
	go test ./... -v -count=1

## build: compile the provider binary for the host.
.PHONY: build
build:
	go build -o $(BIN)/provider ./cmd/provider

## image: build the controller container image.
.PHONY: image
image:
	docker build --platform=$(PLATFORM) -t $(IMG) .

## xpkg: build the Crossplane provider package (embeds the controller image).
## Requires the `crossplane` CLI and a locally-built $(IMG).
.PHONY: xpkg
xpkg: image
	crossplane xpkg build \
	  --package-root=package \
	  --embed-runtime-image=$(IMG) \
	  --package-file=$(BIN)/provider-akash.xpkg

## clean: remove build artifacts.
.PHONY: clean
clean:
	rm -rf $(BIN)
