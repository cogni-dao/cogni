// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/authorization-core/tests/rbac-model`
 * Purpose: Pin the authored OpenFGA billing-account model consumed by the shared adapter.
 * Scope: Reads the repository model JSON only. Does not call OpenFGA or mutate configuration.
 * Invariants: Account grants are exact-resource, conditional, and capability-derived.
 * Side-effects: IO (reads the checked-in model fixture)
 * Links: infra/openfga/rbac-model.json, task.5216
 * @internal
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface ModelRelation {
  readonly this?: Readonly<Record<string, never>>;
  readonly computedUserset?: { readonly relation: string };
  readonly union?: {
    readonly child: ReadonlyArray<{
      readonly computedUserset?: { readonly relation: string };
    }>;
  };
}

interface ModelType {
  readonly type: string;
  readonly relations?: Readonly<Record<string, ModelRelation>>;
  readonly metadata?: {
    readonly relations?: Readonly<
      Record<
        string,
        {
          readonly directly_related_user_types?: ReadonlyArray<{
            readonly type: string;
            readonly condition?: string;
          }>;
        }
      >
    >;
  };
}

interface AuthorizationModel {
  readonly type_definitions: readonly ModelType[];
  readonly conditions?: Readonly<
    Record<
      string,
      {
        readonly expression: string;
        readonly parameters: Readonly<
          Record<string, { readonly type_name: string }>
        >;
      }
    >
  >;
}

const model = JSON.parse(
  readFileSync(
    new URL("../../../infra/openfga/rbac-model.json", import.meta.url),
    "utf8"
  )
) as AuthorizationModel;

describe("billing_account OpenFGA model", () => {
  it("derives read, grant, and scoped OBO capabilities from grantable roles", () => {
    const account = model.type_definitions.find(
      (definition) => definition.type === "billing_account"
    );

    expect(account?.relations).toMatchObject({
      owner: { this: {} },
      reader: { this: {} },
      delegate: { this: {} },
      can_read: {
        union: {
          child: [
            { computedUserset: { relation: "owner" } },
            { computedUserset: { relation: "reader" } },
          ],
        },
      },
      can_grant: { computedUserset: { relation: "owner" } },
      can_act_as: { computedUserset: { relation: "delegate" } },
    });
  });

  it("requires time conditions on delegated readers and actors", () => {
    const account = model.type_definitions.find(
      (definition) => definition.type === "billing_account"
    );

    expect(account?.metadata?.relations?.reader).toEqual({
      directly_related_user_types: [
        { type: "user", condition: "grant_not_expired" },
        { type: "agent", condition: "grant_not_expired" },
      ],
    });
    expect(account?.metadata?.relations?.delegate).toEqual({
      directly_related_user_types: [
        { type: "agent", condition: "grant_not_expired" },
      ],
    });
    expect(model.conditions?.grant_not_expired).toEqual({
      name: "grant_not_expired",
      expression: "current_time < expires_at",
      parameters: {
        current_time: { type_name: "TYPE_NAME_TIMESTAMP" },
        expires_at: { type_name: "TYPE_NAME_TIMESTAMP" },
      },
    });
  });
});
