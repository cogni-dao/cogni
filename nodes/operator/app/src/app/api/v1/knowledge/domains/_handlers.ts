// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/domains/_handlers`
 * Purpose: HTTP handlers for the knowledge domain registry — list, register, and guarded delete, mapping typed errors to HTTP statuses.
 * Scope: Operator-side wiring only. Does not contain business logic, validation, or storage I/O — those live in the port/adapter.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER,
 *   DOMAIN_AUTHENTICATED_CONTROL_PLANE, DOMAIN_DELETE_EMPTY_ONLY.
 * Side-effects: IO (HTTP response, Doltgres read/write via container port)
 * Links: docs/spec/knowledge-domain-registry.md, docs/spec/knowledge-syntropy.md
 * @internal
 */

import {
  DomainAlreadyRegisteredError,
  DomainInUseError,
} from "@cogni/knowledge-store";
import {
  DomainsCreateRequestSchema,
  DomainsCreateResponseSchema,
  DomainsDeleteConflictResponseSchema,
  DomainsDeleteRequestSchema,
  DomainsDeleteResponseSchema,
} from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { NextResponse } from "next/server";

import { loadDomains } from "@/app/(app)/knowledge/_server/loaders";
import { getContainer } from "@/bootstrap/container";

function port() {
  return getContainer().knowledgeStorePort ?? null;
}

export async function handleList(
  _request: Request,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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

export async function handleDelete(
  id: string,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = DomainsDeleteRequestSchema.safeParse({ id });
  if (!parsed.success)
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 }
    );

  const p = port();
  if (!p)
    return NextResponse.json(
      { error: "knowledge store not configured" },
      { status: 503 }
    );

  try {
    const deleted = await p.deleteDomain(parsed.data.id);
    if (!deleted) {
      return NextResponse.json(
        { error: `domain '${parsed.data.id}' not found` },
        { status: 404 }
      );
    }
    return NextResponse.json(
      DomainsDeleteResponseSchema.parse({
        id: parsed.data.id,
        deleted: true,
      })
    );
  } catch (error: unknown) {
    if (error instanceof DomainInUseError) {
      return NextResponse.json(
        DomainsDeleteConflictResponseSchema.parse({
          error: "domain_in_use",
          domain: error.domain,
          entryCount: error.entryCount,
          referenceCount: error.referenceCount,
        }),
        { status: 409 }
      );
    }
    throw error;
  }
}
