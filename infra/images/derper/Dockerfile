# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# task.5428 — the env relay (DERP + STUN) for the per-env mesh (hub node-service-delivery §1, CD10).
# Tailscale publishes no derper image, so CI builds stock upstream cmd/derper at a pinned version and
# the runtime Compose file pins the result BY DIGEST. No source edit, no custom code.
# `go install <module>@<version>` verifies every module against go.sum and the public checksum
# database (sum.golang.org), so the build input is immutable.
# tailscale.com@v1.104.4 requires go >= 1.27.3; GOTOOLCHAIN=local refuses a silent toolchain download.
FROM golang:1.27.3-trixie@sha256:af1bfc2614ebb1dbd31af514b78740fd678850e76498762b425ecee4c5c6ea80 AS build
ENV CGO_ENABLED=0 \
    GOFLAGS=-trimpath \
    GOTOOLCHAIN=local
RUN go install -ldflags="-s -w" tailscale.com/cmd/derper@v1.104.4 \
    && go version -m /go/bin/derper | grep -q 'tailscale.com[[:space:]]*v1.104.4'

# distroless static: CA roots for the -verify-client-url HTTPS call, no shell, uid 65532.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /go/bin/derper /usr/local/bin/derper
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/derper"]
