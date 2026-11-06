// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/headscale-v0.29.7.descriptor`
 * Purpose: The Headscale v0.29.7 gRPC schema the operator's mesh client speaks, as a protobufjs JSON
 *   descriptor (task.5429). It is the subset of `headscale.v1.HeadscaleService` the sequencer needs and
 *   nothing more: the client has no CreateApiKey, RegisterNode, SetTags or debug method to call.
 * Scope: Data only. Does not read a `.proto` file at run time: it is bundled into the sequencer artifact.
 * Invariants:
 *   - PINNED_TO_THE_TAG: every message and method here equals the vendored upstream files in
 *     `headscale-proto-v0.29.7/` (tag v0.29.7, commit c9cf210b8bc84d13177e18b91f555788a44b47b6), field
 *     by field. `tests/component/node-deploy/headscale.adapter.int.test.ts` fails on any drift.
 *   - SUBSET_ONLY: adding a method means adding it to HEADSCALE_CLIENT_METHODS and regenerating this file
 *     from the vendored protos; never hand-edit a field.
 * Side-effects: none
 * Links: headscale.adapter.ts, headscale-proto-v0.29.7/headscale/v1/headscale.proto
 * @internal
 */

/** The methods this client may call. The component contract test pins this list against the vendored service. */
export const HEADSCALE_CLIENT_METHODS = [
  "Health",
  "GetPolicy",
  "SetPolicy",
  "CreateUser",
  "ListUsers",
  "CreatePreAuthKey",
  "ExpirePreAuthKey",
  "ListPreAuthKeys",
  "ListNodes",
  "DeleteNode",
  "AuthRegister",
  "ListApiKeys",
] as const;

export type HeadscaleClientMethod = (typeof HEADSCALE_CLIENT_METHODS)[number];

/** protobufjs JSON (INamespace) form; `fromJSON` from `@grpc/proto-loader` consumes it. */
export const HEADSCALE_V0_29_7_DESCRIPTOR = {
  nested: {
    google: {
      nested: {
        protobuf: {
          nested: {
            Timestamp: {
              fields: {
                seconds: {
                  type: "int64",
                  id: 1,
                },
                nanos: {
                  type: "int32",
                  id: 2,
                },
              },
            },
          },
        },
      },
    },
    headscale: {
      nested: {
        v1: {
          nested: {
            ApiKey: {
              fields: {
                id: {
                  type: "uint64",
                  id: 1,
                },
                prefix: {
                  type: "string",
                  id: 2,
                },
                expiration: {
                  type: "google.protobuf.Timestamp",
                  id: 3,
                },
                created_at: {
                  type: "google.protobuf.Timestamp",
                  id: 4,
                },
                last_seen: {
                  type: "google.protobuf.Timestamp",
                  id: 5,
                },
              },
            },
            AuthRegisterRequest: {
              fields: {
                user: {
                  type: "string",
                  id: 1,
                },
                auth_id: {
                  type: "string",
                  id: 2,
                },
              },
            },
            AuthRegisterResponse: {
              fields: {
                node: {
                  type: "Node",
                  id: 1,
                },
              },
            },
            CreatePreAuthKeyRequest: {
              fields: {
                user: {
                  type: "uint64",
                  id: 1,
                },
                reusable: {
                  type: "bool",
                  id: 2,
                },
                ephemeral: {
                  type: "bool",
                  id: 3,
                },
                expiration: {
                  type: "google.protobuf.Timestamp",
                  id: 4,
                },
                acl_tags: {
                  rule: "repeated",
                  type: "string",
                  id: 5,
                },
              },
            },
            CreatePreAuthKeyResponse: {
              fields: {
                pre_auth_key: {
                  type: "PreAuthKey",
                  id: 1,
                },
              },
            },
            CreateUserRequest: {
              fields: {
                name: {
                  type: "string",
                  id: 1,
                },
                display_name: {
                  type: "string",
                  id: 2,
                },
                email: {
                  type: "string",
                  id: 3,
                },
                picture_url: {
                  type: "string",
                  id: 4,
                },
              },
            },
            CreateUserResponse: {
              fields: {
                user: {
                  type: "User",
                  id: 1,
                },
              },
            },
            DeleteNodeRequest: {
              fields: {
                node_id: {
                  type: "uint64",
                  id: 1,
                },
              },
            },
            DeleteNodeResponse: {
              fields: {},
            },
            ExpirePreAuthKeyRequest: {
              fields: {
                id: {
                  type: "uint64",
                  id: 1,
                },
              },
            },
            ExpirePreAuthKeyResponse: {
              fields: {},
            },
            GetPolicyRequest: {
              fields: {},
            },
            GetPolicyResponse: {
              fields: {
                policy: {
                  type: "string",
                  id: 1,
                },
                updated_at: {
                  type: "google.protobuf.Timestamp",
                  id: 2,
                },
              },
            },
            HealthRequest: {
              fields: {},
            },
            HealthResponse: {
              fields: {
                database_connectivity: {
                  type: "bool",
                  id: 1,
                },
              },
            },
            ListApiKeysRequest: {
              fields: {},
            },
            ListApiKeysResponse: {
              fields: {
                api_keys: {
                  rule: "repeated",
                  type: "ApiKey",
                  id: 1,
                },
              },
            },
            ListNodesRequest: {
              fields: {
                user: {
                  type: "string",
                  id: 1,
                },
              },
            },
            ListNodesResponse: {
              fields: {
                nodes: {
                  rule: "repeated",
                  type: "Node",
                  id: 1,
                },
              },
            },
            ListPreAuthKeysRequest: {
              fields: {},
            },
            ListPreAuthKeysResponse: {
              fields: {
                pre_auth_keys: {
                  rule: "repeated",
                  type: "PreAuthKey",
                  id: 1,
                },
              },
            },
            ListUsersRequest: {
              fields: {
                id: {
                  type: "uint64",
                  id: 1,
                },
                name: {
                  type: "string",
                  id: 2,
                },
                email: {
                  type: "string",
                  id: 3,
                },
              },
            },
            ListUsersResponse: {
              fields: {
                users: {
                  rule: "repeated",
                  type: "User",
                  id: 1,
                },
              },
            },
            Node: {
              fields: {
                id: {
                  type: "uint64",
                  id: 1,
                },
                machine_key: {
                  type: "string",
                  id: 2,
                },
                node_key: {
                  type: "string",
                  id: 3,
                },
                disco_key: {
                  type: "string",
                  id: 4,
                },
                ip_addresses: {
                  rule: "repeated",
                  type: "string",
                  id: 5,
                },
                name: {
                  type: "string",
                  id: 6,
                },
                user: {
                  type: "User",
                  id: 7,
                },
                last_seen: {
                  type: "google.protobuf.Timestamp",
                  id: 8,
                },
                expiry: {
                  type: "google.protobuf.Timestamp",
                  id: 10,
                },
                pre_auth_key: {
                  type: "PreAuthKey",
                  id: 11,
                },
                created_at: {
                  type: "google.protobuf.Timestamp",
                  id: 12,
                },
                register_method: {
                  type: "RegisterMethod",
                  id: 13,
                },
                given_name: {
                  type: "string",
                  id: 21,
                },
                online: {
                  type: "bool",
                  id: 22,
                },
                approved_routes: {
                  rule: "repeated",
                  type: "string",
                  id: 23,
                },
                available_routes: {
                  rule: "repeated",
                  type: "string",
                  id: 24,
                },
                subnet_routes: {
                  rule: "repeated",
                  type: "string",
                  id: 25,
                },
                tags: {
                  rule: "repeated",
                  type: "string",
                  id: 26,
                },
              },
              reserved: [
                [9, 9],
                [14, 20],
              ],
            },
            PreAuthKey: {
              fields: {
                user: {
                  type: "User",
                  id: 1,
                },
                id: {
                  type: "uint64",
                  id: 2,
                },
                key: {
                  type: "string",
                  id: 3,
                },
                reusable: {
                  type: "bool",
                  id: 4,
                },
                ephemeral: {
                  type: "bool",
                  id: 5,
                },
                used: {
                  type: "bool",
                  id: 6,
                },
                expiration: {
                  type: "google.protobuf.Timestamp",
                  id: 7,
                },
                created_at: {
                  type: "google.protobuf.Timestamp",
                  id: 8,
                },
                acl_tags: {
                  rule: "repeated",
                  type: "string",
                  id: 9,
                },
              },
            },
            RegisterMethod: {
              values: {
                REGISTER_METHOD_UNSPECIFIED: 0,
                REGISTER_METHOD_AUTH_KEY: 1,
                REGISTER_METHOD_CLI: 2,
                REGISTER_METHOD_OIDC: 3,
              },
            },
            SetPolicyRequest: {
              fields: {
                policy: {
                  type: "string",
                  id: 1,
                },
              },
            },
            SetPolicyResponse: {
              fields: {
                policy: {
                  type: "string",
                  id: 1,
                },
                updated_at: {
                  type: "google.protobuf.Timestamp",
                  id: 2,
                },
              },
            },
            User: {
              fields: {
                id: {
                  type: "uint64",
                  id: 1,
                },
                name: {
                  type: "string",
                  id: 2,
                },
                created_at: {
                  type: "google.protobuf.Timestamp",
                  id: 3,
                },
                display_name: {
                  type: "string",
                  id: 4,
                },
                email: {
                  type: "string",
                  id: 5,
                },
                provider_id: {
                  type: "string",
                  id: 6,
                },
                provider: {
                  type: "string",
                  id: 7,
                },
                profile_pic_url: {
                  type: "string",
                  id: 8,
                },
              },
            },
            HeadscaleService: {
              methods: {
                Health: {
                  requestType: "HealthRequest",
                  responseType: "HealthResponse",
                },
                GetPolicy: {
                  requestType: "GetPolicyRequest",
                  responseType: "GetPolicyResponse",
                },
                SetPolicy: {
                  requestType: "SetPolicyRequest",
                  responseType: "SetPolicyResponse",
                },
                CreateUser: {
                  requestType: "CreateUserRequest",
                  responseType: "CreateUserResponse",
                },
                ListUsers: {
                  requestType: "ListUsersRequest",
                  responseType: "ListUsersResponse",
                },
                CreatePreAuthKey: {
                  requestType: "CreatePreAuthKeyRequest",
                  responseType: "CreatePreAuthKeyResponse",
                },
                ExpirePreAuthKey: {
                  requestType: "ExpirePreAuthKeyRequest",
                  responseType: "ExpirePreAuthKeyResponse",
                },
                ListPreAuthKeys: {
                  requestType: "ListPreAuthKeysRequest",
                  responseType: "ListPreAuthKeysResponse",
                },
                ListNodes: {
                  requestType: "ListNodesRequest",
                  responseType: "ListNodesResponse",
                },
                DeleteNode: {
                  requestType: "DeleteNodeRequest",
                  responseType: "DeleteNodeResponse",
                },
                AuthRegister: {
                  requestType: "AuthRegisterRequest",
                  responseType: "AuthRegisterResponse",
                },
                ListApiKeys: {
                  requestType: "ListApiKeysRequest",
                  responseType: "ListApiKeysResponse",
                },
              },
            },
          },
        },
      },
    },
  },
};
