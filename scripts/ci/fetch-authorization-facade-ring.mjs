#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Fetch one raw authority ring into a same-process stdout pipe; never persist or log it. */

const audience = "cogni-authorization-facade-projection";
const controlUrl = process.env.AUTHORIZATION_FACADE_CONTROL_URL;
const lane = process.env.AUTHORIZATION_FACADE_LANE;
const nodeId = process.env.AUTHORIZATION_FACADE_NODE_ID;
const oidcUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const oidcRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const credential = new RegExp(
  `^cogni_naz_sk_v2_${lane ?? "invalid"}_${nodeId ?? "invalid"}_[0-9a-f]{64}$`
);

function fail() {
  process.stderr.write("authorization-facade projection fetch failed\n");
  process.exit(1);
}

async function boundedText(response, maxBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes) {
      fail();
    }
  }
  if (!response.body) fail();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      fail();
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total
  ).toString("utf8");
}

if (
  !controlUrl ||
  !lane ||
  !nodeId ||
  !oidcUrl ||
  !oidcRequestToken ||
  !/^(candidate-a|preview|production)$/.test(lane) ||
  !uuid.test(nodeId)
) {
  fail();
}

let base;
try {
  base = new URL(controlUrl);
} catch {
  fail();
}
if (
  base.protocol !== "https:" ||
  base.username ||
  base.password ||
  base.pathname !== "/" ||
  base.search ||
  base.hash
) {
  fail();
}

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15_000);
try {
  const tokenUrl = new URL(oidcUrl);
  if (
    tokenUrl.protocol !== "https:" ||
    tokenUrl.username ||
    tokenUrl.password ||
    tokenUrl.hash
  ) {
    fail();
  }
  tokenUrl.searchParams.set("audience", audience);
  const oidcResponse = await fetch(tokenUrl, {
    headers: { Authorization: `Bearer ${oidcRequestToken}` },
    redirect: "error",
    signal: controller.signal,
  });
  if (!oidcResponse.ok) fail();
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      oidcResponse.headers.get("content-type") ?? ""
    )
  ) {
    fail();
  }
  const oidcText = await boundedText(oidcResponse, 16_384);
  const oidcBody = JSON.parse(oidcText);
  if (typeof oidcBody.value !== "string" || oidcBody.value.length > 8192)
    fail();

  const endpoint = new URL(
    "/api/internal/authorization-facade-credentials",
    base
  );
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
  if (!response.ok || response.headers.get("cache-control") !== "no-store")
    fail();
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get("content-type") ?? ""
    )
  ) {
    fail();
  }
  const text = await boundedText(response, 600);
  const ring = JSON.parse(text);
  if (
    !ring ||
    typeof ring !== "object" ||
    Array.isArray(ring) ||
    Object.keys(ring).sort().join(",") !== "active,previous" ||
    typeof ring.active !== "string" ||
    !credential.test(ring.active) ||
    (ring.previous !== null &&
      (typeof ring.previous !== "string" ||
        !credential.test(ring.previous) ||
        ring.previous === ring.active))
  ) {
    fail();
  }
  process.stdout.write(JSON.stringify(ring));
} catch {
  fail();
} finally {
  clearTimeout(timeout);
}
