// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/domains/_handlers`
 * Purpose: HTTP handlers for the knowledge domain registry — list and register, mapping typed errors to HTTP statuses.
 * Scope: Operator-side wiring only. Does not contain business logic, validation, or storage I/O — those live in the port/adapter.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, DOMAIN_LIST_COOKIE_ONLY
 *   (browse is a UI concern), DOMAIN_REGISTER_BEARER_OR_SESSION (federation:
 *   external bearer agents may register a domain on-demand so that downstream
 *   writes — knowledge contributions, EDO hypothesize/decide/record-outcome —
 *   can proceed against the DOMAIN_FK_ENFORCED_AT_WRITE adapter invariant
 *   without requiring a UI roundtrip).
 * Side-effects: IO (HTTP response, Doltgres read/write via container port)
 * Links: docs/spec/knowledge-domain-registry.md, docs/spec/knowledge-syntropy.md
 * @internal
 */

import { DomainAlreadyRegisteredError } from "@cogni/knowledge-store";
import {
  DomainsCreateRequestSchema,
  DomainsCreateResponseSchema,
  DomainsListResponseSchema,
} from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { NextResponse } from "next/server";

import { getContainer } from "@/bootstrap/container";

function port() {
  return getContainer().knowledgeStorePort ?? null;
}

function isBearer(request: Request): boolean {
  const authz = request.headers.get("authorization") ?? "";
  return authz.toLowerCase().startsWith("bearer ");
}

export async function handleList(
  request: Request,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (isBearer(request))
    return NextResponse.json(
      { error: "knowledge domains require a session cookie (v0)" },
      { status: 403 }
    );
  const p = port();
  if (!p)
    return NextResponse.json(
      { error: "knowledge store not configured" },
      { status: 503 }
    );
  const domains = await p.listDomainsFull();
  return NextResponse.json(DomainsListResponseSchema.parse({ domains }));
}

export async function handleCreate(
  request: Request,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Bearer agents may register a domain on-demand to satisfy
  // DOMAIN_FK_ENFORCED_AT_WRITE before downstream writes
  // (knowledge contributions + EDO hypothesize/decide/record-outcome).
  // Touch via underscore so the linter doesn't warn.
  void isBearer(request);
  const p = port();
  if (!p)
    return NextResponse.json(
      { error: "knowledge store not configured" },
      { status: 503 }
    );

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = DomainsCreateRequestSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 }
    );

  try {
    const domain = await p.registerDomain({
      id: parsed.data.id,
      name: parsed.data.name,
      ...(parsed.data.description != null
        ? { description: parsed.data.description }
        : {}),
    });
    return NextResponse.json(DomainsCreateResponseSchema.parse(domain), {
      status: 201,
    });
  } catch (e: unknown) {
    if (e instanceof DomainAlreadyRegisteredError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    throw e;
  }
}
