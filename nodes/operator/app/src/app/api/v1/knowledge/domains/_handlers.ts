// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/domains/_handlers`
 * Purpose: HTTP handlers for the knowledge domain registry — list, register and item CRUD, mapping typed errors to HTTP statuses.
 * Scope: Operator auth, validation and error mapping; storage and admission stay in the port/adapter.
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

import {
  DomainAlreadyRegisteredError,
  DomainNotEmptyError,
  DomainNotRegisteredError,
  KnowledgeBusyError,
  KnowledgeWriteConflictError,
  KnowledgeWriteOutcomeUnknownError,
  KnowledgeWriteScopeRequiredError,
} from "@cogni/knowledge-store";
import {
  DomainIdSchema,
  DomainsCreateRequestSchema,
  DomainsCreateResponseSchema,
  type DomainsErrorResponse,
  DomainsErrorResponseSchema,
  DomainsUpdateBodySchema,
  domainsDeleteOperation,
  domainsGetOperation,
  domainsUpdateOperation,
} from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { NextResponse } from "next/server";

import { loadDomains } from "@/app/(app)/knowledge/_server/loaders";
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
  return NextResponse.json(await loadDomains(p));
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
    return domainWriteError(e);
  }
}

function domainWriteError(e: unknown): NextResponse {
  if (e instanceof KnowledgeWriteOutcomeUnknownError)
    return NextResponse.json(
      {
        error: e.message,
        errorCode: e.code,
        retryable: false,
        ...e.receipt.lookup,
      },
      { status: 409 }
    );
  if (e instanceof KnowledgeWriteConflictError)
    return NextResponse.json(
      {
        error: e.message,
        errorCode: e.receipt.code,
        retryable: false,
        ...e.receipt.lookup,
      },
      { status: 409 }
    );
  if (e instanceof KnowledgeWriteScopeRequiredError)
    return NextResponse.json(
      {
        error: e.message,
        errorCode: "knowledge_write_scope_required",
        retryable: false,
      },
      { status: 500 }
    );
  if (e instanceof KnowledgeBusyError)
    return NextResponse.json(
      { error: e.message, errorCode: "knowledge_busy", retryable: true },
      { status: 503, headers: { "Retry-After": "2" } }
    );
  if (e instanceof DomainAlreadyRegisteredError) {
    return NextResponse.json({ error: e.message }, { status: 409 });
  }
  throw e;
}

function domainError(status: number, body: DomainsErrorResponse): NextResponse {
  return NextResponse.json(DomainsErrorResponseSchema.parse(body), { status });
}

function missingDomain(id: string): NextResponse {
  return domainError(404, {
    error: `domain '${id}' not registered`,
    errorCode: "domain_not_found",
  });
}

export async function handleGet(
  domain: string,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return domainError(401, {
      error: "unauthorized",
      errorCode: "unauthorized",
    });
  const input = DomainIdSchema.safeParse(domain);
  if (!input.success)
    return domainError(400, {
      error: "invalid domain id",
      errorCode: "invalid_input",
      issues: input.error.issues,
    });
  const p = port();
  if (!p)
    return domainError(503, {
      error: "knowledge store not configured",
      errorCode: "store_not_configured",
    });
  const row = await p.getDomain(input.data);
  return row
    ? NextResponse.json(domainsGetOperation.output.parse(row))
    : missingDomain(input.data);
}

export async function handleUpdate(
  request: Request,
  domain: string,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return domainError(401, {
      error: "unauthorized",
      errorCode: "unauthorized",
    });
  const input = DomainIdSchema.safeParse(domain);
  if (!input.success)
    return domainError(400, {
      error: "invalid domain id",
      errorCode: "invalid_input",
      issues: input.error.issues,
    });
  const p = port();
  if (!p)
    return domainError(503, {
      error: "knowledge store not configured",
      errorCode: "store_not_configured",
    });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return domainError(400, {
      error: "invalid JSON body",
      errorCode: "invalid_json",
    });
  }
  const patch = DomainsUpdateBodySchema.safeParse(body);
  if (!patch.success)
    return domainError(400, {
      error: "invalid input",
      errorCode: "invalid_input",
      issues: patch.error.issues,
    });
  try {
    return NextResponse.json(
      domainsUpdateOperation.output.parse(
        await p.updateDomain(input.data, patch.data)
      )
    );
  } catch (error) {
    if (error instanceof DomainNotRegisteredError)
      return missingDomain(error.domain);
    return domainWriteError(error);
  }
}

export async function handleDelete(
  domain: string,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return domainError(401, {
      error: "unauthorized",
      errorCode: "unauthorized",
    });
  const input = DomainIdSchema.safeParse(domain);
  if (!input.success)
    return domainError(400, {
      error: "invalid domain id",
      errorCode: "invalid_input",
      issues: input.error.issues,
    });
  const p = port();
  if (!p)
    return domainError(503, {
      error: "knowledge store not configured",
      errorCode: "store_not_configured",
    });
  if (["meta", "mission", "strategy"].includes(input.data))
    return domainError(409, {
      error: `domain '${input.data}' is protected`,
      errorCode: "domain_protected",
    });
  try {
    await p.deleteDomain(input.data);
    return NextResponse.json(
      domainsDeleteOperation.output.parse({ id: input.data, deleted: true })
    );
  } catch (error) {
    if (error instanceof DomainNotRegisteredError)
      return missingDomain(error.domain);
    if (error instanceof DomainNotEmptyError)
      return domainError(409, {
        error: error.message,
        errorCode: "domain_not_empty",
        entryCount: error.entryCount,
      });
    return domainWriteError(error);
  }
}
