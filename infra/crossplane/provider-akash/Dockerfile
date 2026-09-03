# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# Multi-stage build of the provider-akash controller. The resulting image is the
# runtime embedded into the Crossplane provider package (see `make xpkg`).
FROM --platform=$BUILDPLATFORM golang:1.23 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# TARGETOS/TARGETARCH are auto-populated by buildx from --platform (declared with
# NO default so the build target — not the build host — selects the binary arch).
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -o /out/provider ./cmd/provider

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/provider /usr/local/bin/provider
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/provider"]
