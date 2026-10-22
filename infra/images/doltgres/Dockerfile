# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
# Qualification only; no Compose or environment image pin is changed here.
# Preserve upstream v0.57.3 runtime configuration and replace only its binary.
FROM golang:1.26.2-trixie@sha256:4a7137ea573f79c86ae451ff05817ed762ef5597fcf732259e97abeb3108d873 AS build

ENV GOTOOLCHAIN=local \
    CGO_ENABLED=1 \
    CC=x86_64-linux-musl-gcc \
    CXX=x86_64-linux-musl-g++ \
    AS=x86_64-linux-musl-as \
    CGO_LDFLAGS="-static -s" \
    PATH="/opt/cross/bin:${PATH}"
WORKDIR /src

# All source/toolchain inputs are immutable and verified before extraction.
# These are the Linux-amd64 artifacts used by upstream scripts/build_binaries.sh;
# execute the same native build flags without that script's unverified downloads.
RUN test "$(uname -m)" = x86_64 \
    && test "$(go env GOVERSION)" = go1.26.2 \
    && curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
       https://codeload.github.com/dolthub/doltgresql/tar.gz/f4bc507d9764f9b7b2e1a5dca740b03d7e30f0ca -o /tmp/upstream.tar.gz \
    && echo '451a17c204309db3d091f39b59d8b71b1cd19f2d3b640c8d4e55989c0715dfd1  /tmp/upstream.tar.gz' | sha256sum --check --strict \
    && tar -xzf /tmp/upstream.tar.gz --strip-components=1 -C /src \
    && curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
       https://dolthub-tools.s3.us-west-2.amazonaws.com/optcross/x86_64-linux_20250327_0.0.3_trixie.tar.xz -o /tmp/cross.tar.xz \
    && echo '61cc576d437cee5cb3602771be202e4a25111735ec0ec0ff990dc985db22e623  /tmp/cross.tar.xz' | sha256sum --check --strict \
    && tar -xJf /tmp/cross.tar.xz -C / \
    && curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
       https://dolthub-tools.s3.us-west-2.amazonaws.com/icustatic/20250327_0.0.3_trixie.tar.xz -o /tmp/icu.tar.xz \
    && echo '7dfb587bb8e126baa7933a6f03aedfb01f2abe3510c7ca193b1fd8e96abe0d11  /tmp/icu.tar.xz' | sha256sum --check --strict \
    && tar -xJf /tmp/icu.tar.xz -C / \
    && rm /tmp/upstream.tar.gz /tmp/cross.tar.xz /tmp/icu.tar.xz

COPY session-attribution.patch /tmp/session-attribution.patch
RUN echo 'ee6ab766777b27f283b3eec927eb7ed4db919d27d7cb18eaf90916e32f2f4cad  /tmp/session-attribution.patch' | sha256sum --check --strict \
    && git apply --unidiff-zero --check /tmp/session-attribution.patch \
    && git apply --unidiff-zero /tmp/session-attribution.patch \
    && echo '25144b9786b8de6e556eb79d2981c849c74636dbf9ab85086957e27bee78eb6a  server/tables/pgcatalog/pg_stat_activity.go' | sha256sum --check --strict \
    && echo '74343f5d7688a28665d2fdb82b3ec8a3a594dc906a12b362344536ac06ae4db2  server/tables/pgcatalog/pg_stat_activity_test.go' | sha256sum --check --strict \
    && go mod download \
    && go mod verify \
    && ./postgres/parser/build.sh \
    && go test -timeout=10m -tags icu_static ./server/tables/pgcatalog -run '^TestPgStat' -count=1 -v \
    && go build -buildvcs=false -trimpath -ldflags='-linkmode external -s -w' -tags icu_static -o /out/doltgres ./cmd/doltgres \
    && sha256sum /out/doltgres

FROM dolthub/doltgresql:0.57.3@sha256:1eccbe3a4a65564b62b4bd90ed8265c2e9452687dfac47061bf0c7212bd8ae31
COPY --from=build /out/doltgres /usr/local/bin/doltgres
