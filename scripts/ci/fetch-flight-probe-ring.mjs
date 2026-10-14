#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/ci/fetch-flight-probe-ring`
 * Purpose: Exchange GitHub OIDC for one catalog node's bounded flight-prober ring.
 * Scope: Reads the control projection endpoint; does not persist or log credentials.
 * Invariants: OIDC is target-lane-audienced; response is no-store and bounded; errors expose no values.
 * Side-effects: IO (GitHub OIDC and fixed control operator HTTPS requests)
 * Links: .github/workflows/flight-probe-project.yml, scripts/ci/project-flight-probe-ring.sh
 * @internal
 */

const audience = "cogni-flight-probe-projection";
const controlUrl = process.env.FLIGHT_PROBE_CONTROL_URL;
const lane = process.env.FLIGHT_PROBE_LANE;
const nodeId = process.env.FLIGHT_PROBE_NODE_ID;
const oidcUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const oidcRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

function fail() {
  process.stderr.write("flight-probe projection fetch failed\n");
  process.exit(1);
}

if (
  !controlUrl ||
  !lane ||
  !nodeId ||
  !oidcUrl ||
  !oidcRequestToken ||
  !/^(candidate-a|preview|production)$/.test(lane) ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    nodeId
  )
) {
  fail();
}

let base;
try {
  base = new URL(controlUrl);
} catch {
  fail();
}
if (base.protocol !== "https:" || base.username || base.password) fail();

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15_000);
try {
  const tokenUrl = new URL(oidcUrl);
  tokenUrl.searchParams.set("audience", audience);
  const oidcResponse = await fetch(tokenUrl, {
    headers: { Authorization: `Bearer ${oidcRequestToken}` },
    signal: controller.signal,
  });
  if (!oidcResponse.ok) fail();
  const oidcText = await oidcResponse.text();
  if (oidcText.length > 16_384) fail();
  const oidcBody = JSON.parse(oidcText);
  if (typeof oidcBody.value !== "string" || oidcBody.value.length > 8192)
    fail();

  const endpoint = new URL("/api/internal/flight-probe-credentials", base);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${oidcBody.value}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ lane, nodeId }),
    redirect: "error",
    signal: controller.signal,
  });
  if (!response.ok || response.headers.get("cache-control") !== "no-store") {
    fail();
  }
  const ring = await response.text();
  if (ring.length > 600) fail();
  const parsed = JSON.parse(ring);
  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "active" ||
    keys[1] !== "previous" ||
    typeof parsed.active !== "string" ||
    parsed.active.length < 32 ||
    parsed.active.length > 256 ||
    (parsed.previous !== null &&
      (typeof parsed.previous !== "string" ||
        parsed.previous.length < 32 ||
        parsed.previous.length > 256 ||
        parsed.previous === parsed.active))
  ) {
    fail();
  }
  process.stdout.write(JSON.stringify(parsed));
} catch {
  fail();
} finally {
  clearTimeout(timeout);
}
