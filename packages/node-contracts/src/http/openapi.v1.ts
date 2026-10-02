// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/http/openapi.v1`
 * Purpose: OpenAPI specification generation from ts-rest router.
 * Scope: Creates OpenAPI v3 document from HTTP contracts. Does not include implementation details.
 * Invariants: Generated spec matches ts-rest router exactly; operation IDs stable.
 * Side-effects: none
 * Notes: Used by OpenAPI endpoint and documentation tools.
 * Links: ts-rest router, OpenAPI endpoint
 * @internal
 */

import { generateOpenApi } from "@ts-rest/open-api";

import { ApiContractV1 } from "./router.v1";

export const OpenAPIV1 = generateOpenApi(
  ApiContractV1,
  {
    info: {
      title: "Cogni Template API",
      version: "1.0.0",
      description: "Public HTTP API for Cogni Template.",
    },
    servers: [{ url: "/api/v1", description: "V1 API" }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Node-issued agent API key.",
        },
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "next-auth.session-token",
          description:
            "Authenticated NextAuth session cookie; secure deployments may prefix the cookie name.",
        },
      },
    },
  },
  {
    setOperationId: true,
    operationMapper: (operation, route) => {
      const metadata = route.metadata as { auth?: string } | undefined;
      if (metadata?.auth !== "bearer-or-session") return operation;
      return {
        ...operation,
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      };
    },
  }
);
