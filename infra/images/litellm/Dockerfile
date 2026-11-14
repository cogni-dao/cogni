# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Cogni LiteLLM — extends upstream with per-node billing callback routing.
# The custom callback class (cogni_callbacks.py) routes billing events to the
# correct node's ingest endpoint based on node_id metadata.
# See: https://node-template.cognidao.org/knowledge/node-tenancy-isolation (CALLBACK_IS_ADAPTER_GLUE)

FROM ghcr.io/berriai/litellm@sha256:7e7816d58c265c182be5f3568ed8e5d999f11a5deda1d85e8e347a18bc578f64

# Install httpx for async HTTP in the callback (litellm already has it, but pin explicitly)
RUN pip install --no-cache-dir httpx>=0.27

# Copy custom callback module
COPY cogni_callbacks.py /app/cogni_callbacks.py
