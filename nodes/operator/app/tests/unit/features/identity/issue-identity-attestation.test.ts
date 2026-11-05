// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Unit tests for identity-attestation issuance policy with fake ports. */

import { IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256 } from "@cogni/node-contracts";
import { describe, expect, it, vi } from "vitest";
import { OperatorIdentityAttestationRepository } from "@/adapters/server/identity/identity-attestation.adapter";
import {
  AttestationPreconditionError,
  createIdentityAttestationService,
} from "@/features/identity/services/issue-identity-attestation";
import { edgeHostRegexFor } from "@/features/node-deploy/edge";
import { resolveEnvLanes } from "@/features/node-deploy/env-lanes";
import type {
  IdentityAttestationRepositoryPort,
  IdentityAttestationSignerPort,
} from "@/ports";
import {
  resolveRegisteredFleetZones,
  resolveWorkloadZoneBinding,
} from "@/shared/node-registry/fleet-ownership";

const NODE_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST = {
  protocol: IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
  nodeId: NODE_ID,
  nonce: "node_generated_nonce_0123456789abcdef",
  targetOrigin: "https://toks4-test.cognidao.org",
};
const AUTHENTICATED_GITHUB = { id: "12345", login: "flock-leader" };

function service(overrides?: {
  repository?: IdentityAttestationRepositoryPort;
  signer?: IdentityAttestationSignerPort;
}) {
  const repository: IdentityAttestationRepositoryPort =
    overrides?.repository ?? {
      findNode: async () => ({
        nodeId: NODE_ID,
        slug: "toks4",
        repoOwner: "cogni-dao",
        deployEnvs: ["candidate-a", "production"],
      }),
    };
  const signer = overrides?.signer ?? { sign: vi.fn(async () => "signed.jwt") };
  return createIdentityAttestationService({
    repository,
    fleetZoneBindings: [{ fleetOwner: "cogni-dao", zoneName: "cognidao.org" }],
    signer,
    clock: { now: () => "2026-08-17T00:00:00.000Z" },
    createJti: () => "33333333-3333-4333-8333-333333333333",
  });
}

describe("identity attestation issuance service", () => {
  it("signs the GitHub identity supplied by the caller for the exact node request", async () => {
    const sign = vi.fn(async () => "signed.jwt");
    const issued = await service({ signer: { sign } }).issue({
      github: AUTHENTICATED_GITHUB,
      issuer: "https://cognidao.org",
      request: REQUEST,
    });

    expect(issued).toEqual({ attestation: "signed.jwt", expiresIn: 600 });
    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
        aud: `urn:cogni:node:${NODE_ID}`,
        targetOrigin: REQUEST.targetOrigin,
        github: AUTHENTICATED_GITHUB,
      })
    );
    expect(sign.mock.calls[0]?.[0]).not.toHaveProperty("wallet");
    expect(sign.mock.calls[0]?.[0]).not.toHaveProperty("sub");
  });

  /**
   * task.5024 regression: the service has NO way to look a subject up. Before the fix
   * the repository owned `findGithubIdentity(userId)` and the ambient operator session
   * chose the attested account — which bound the wrong GitHub account on the
   * 2026-08-19 candidate. Removing the lookup makes that class of bug unrepresentable.
   */
  it("exposes no subject lookup on the repository port", () => {
    const repository: IdentityAttestationRepositoryPort = {
      findNode: async () => null,
    };
    expect(repository).not.toHaveProperty("findGithubIdentity");
  });

  it("rejects an origin outside the registered deployment set before signing", async () => {
    const sign = vi.fn(async () => "signed.jwt");
    await expect(
      service({ signer: { sign } }).issue({
        github: AUTHENTICATED_GITHUB,
        issuer: "https://cognidao.org",
        request: { ...REQUEST, targetOrigin: "https://attacker.example" },
      })
    ).rejects.toEqual(
      new AttestationPreconditionError("invalid_target_origin")
    );
    expect(sign).not.toHaveBeenCalled();
  });

  it("rejects an unregistered node before signing", async () => {
    const sign = vi.fn(async () => "signed.jwt");
    const repository: IdentityAttestationRepositoryPort = {
      findNode: async () => null,
    };

    await expect(
      service({ repository, signer: { sign } }).issue({
        github: AUTHENTICATED_GITHUB,
        issuer: "https://cognidao.org",
        request: REQUEST,
      })
    ).rejects.toEqual(new AttestationPreconditionError("unknown_node"));
    expect(sign).not.toHaveBeenCalled();
  });

  it("resolves the node for the entry leg without signing anything", async () => {
    const sign = vi.fn(async () => "signed.jwt");
    const node = await service({ signer: { sign } }).resolveNode({
      request: REQUEST,
    });

    expect(node).toEqual({ nodeId: NODE_ID, slug: "toks4" });
    expect(sign).not.toHaveBeenCalled();
  });
});

/**
 * bug.5063 — the node lookup sits on the interactive auth path, in front of a human.
 * The App-authenticated catalog read measured 11.0s cold / 0.22s warm on candidate-a,
 * which a human reads as broken. These pin the ordering that fixes it.
 */
describe("broker node lookup ordering (bug.5063)", () => {
  const ROW = {
    id: NODE_ID,
    slug: "toks4",
    repoOwner: "cogni-dao",
    repoUrl: "https://github.com/cogni-dao/toks4",
    deployEnvs: ["candidate-a", "production"],
  };

  function repoWith(findNodeRow?: (id: string) => Promise<typeof ROW | null>) {
    const listCatalogNodes = vi.fn(async () => [
      {
        nodeId: NODE_ID,
        slug: "toks4",
        repoOwner: "cogni-dao",
        repoUrl: "https://github.com/cogni-dao/toks4",
        deployEnvs: ["candidate-a"],
      },
    ]);
    const repository = new OperatorIdentityAttestationRepository(
      { listCatalogNodes } as never,
      { parentOwner: "Cogni-DAO", parentRepo: "cogni" },
      findNodeRow as never
    );
    return { repository, listCatalogNodes };
  }

  it("never touches the catalog when the projection has the node", async () => {
    const { repository, listCatalogNodes } = repoWith(async () => ROW);

    await expect(repository.findNode(NODE_ID)).resolves.toEqual({
      nodeId: NODE_ID,
      slug: "toks4",
      repoOwner: "cogni-dao",
      deployEnvs: ["candidate-a", "production"],
    });
    // The whole point: no GitHub round trip in front of the human.
    expect(listCatalogNodes).not.toHaveBeenCalled();
  });

  it("falls back to the catalog for a node registered since the last reconcile", async () => {
    // catalog-registry-reconcile polls every ten minutes, so a just-registered node is
    // absent from the projection. Rejecting it would be fail-closed but WRONG —
    // unknown_node for a node that exists. Pay the slow read once instead.
    const { repository, listCatalogNodes } = repoWith(async () => null);

    await expect(repository.findNode(NODE_ID)).resolves.toMatchObject({
      nodeId: NODE_ID,
    });
    expect(listCatalogNodes).toHaveBeenCalledOnce();
  });

  it("propagates a projection read error instead of silently falling open", async () => {
    // The adapter does NOT swallow this. Swallowing here would make a DB outage
    // indistinguishable from "node absent", and the fallback would then quietly
    // re-answer from the catalog on every request — losing the whole fix under load
    // with no signal. Containment belongs at the composition edge: the bootstrap
    // `findNodeRow` catches and returns null, so production degrades to the catalog
    // deliberately and in one place.
    const { repository, listCatalogNodes } = repoWith(async () => {
      throw new Error("db down");
    });

    await expect(repository.findNode(NODE_ID)).rejects.toThrow("db down");
    expect(listCatalogNodes).not.toHaveBeenCalled();
  });
});

describe("registered fleet origin binding", () => {
  it("accepts the test fleet origin on a mixed-fleet broker", async () => {
    const repository = {
      findNode: async () => ({
        nodeId: NODE_ID,
        slug: "toks4",
        deployEnvs: ["candidate-a"],
        repoOwner: "cogni-test-org",
      }),
    };
    const broker = createIdentityAttestationService({
      repository,
      signer: { sign: async () => "signed" },
      clock: { now: () => "2026-08-17T00:00:00.000Z" },
      createJti: () => NODE_ID,
      fleetZoneBindings: [
        { fleetOwner: "cogni-test-org", zoneName: "cogni-testing.org" },
        { fleetOwner: "cogni-dao", zoneName: "cognidao.org" },
      ],
    });
    await expect(
      broker.resolveNode({
        request: {
          ...REQUEST,
          targetOrigin: "https://toks4-test.cogni-testing.org",
        },
      })
    ).resolves.toMatchObject({ nodeId: NODE_ID });
  });
});

describe("fleet configuration", () => {
  const registry = { registryOwner: "Cogni-DAO", registryZone: "cognidao.org" };
  it("permits preview without a local binding and deduplicates production", () => {
    expect(
      resolveRegisteredFleetZones({ ...registry, localOwner: "cogni-test-org" })
    ).toHaveLength(1);
    expect(
      resolveRegisteredFleetZones({
        ...registry,
        localOwner: "cogni-dao",
        localZone: "cognidao.org",
      })
    ).toHaveLength(1);
    expect(
      resolveRegisteredFleetZones({
        ...registry,
        localOwner: "cogni-test-org",
        localZone: "cogni-testing.org",
      })
    ).toHaveLength(2);
  });
  it("uses the shared normalized zone for broker and deployment hosts", () => {
    const local = resolveWorkloadZoneBinding({
      fleetOwner: "cogni-test-org",
      zoneName: "COGNI-TESTING.ORG.",
    });
    const bindings = resolveRegisteredFleetZones({
      ...registry,
      localOwner: "cogni-test-org",
      localZone: "COGNI-TESTING.ORG.",
    });
    expect(local.zoneName).toBe("cogni-testing.org");
    expect(bindings).toContainEqual(local);
    expect(
      edgeHostRegexFor(["toks4"], local.zoneName).test(
        "toks4-test.cogni-testing.org"
      )
    ).toBe(true);
  });

  it("accepts canonical preview and rejects an unmapped test fleet at both legs", async () => {
    let owner = "cogni-dao";
    const sign = vi.fn(async () => "signed");
    const broker = createIdentityAttestationService({
      repository: {
        findNode: async () => ({
          nodeId: NODE_ID,
          slug: "toks4",
          repoOwner: owner,
          deployEnvs: ["preview"],
        }),
      },
      signer: { sign },
      clock: { now: () => "2026-08-17T00:00:00.000Z" },
      createJti: () => NODE_ID,
      fleetZoneBindings: resolveRegisteredFleetZones({
        ...registry,
        localOwner: "cogni-test-org",
      }),
    });
    const request = {
      ...REQUEST,
      targetOrigin: "https://toks4-preview.cognidao.org",
    };
    await expect(broker.resolveNode({ request })).resolves.toMatchObject({
      nodeId: NODE_ID,
    });
    await expect(
      broker.issue({
        github: AUTHENTICATED_GITHUB,
        issuer: "https://preview.cognidao.org",
        request,
      })
    ).resolves.toMatchObject({ attestation: "signed" });
    owner = "cogni-test-org";
    await expect(broker.resolveNode({ request })).rejects.toEqual(
      new AttestationPreconditionError("invalid_target_origin")
    );
    await expect(
      broker.issue({
        github: AUTHENTICATED_GITHUB,
        issuer: "https://preview.cognidao.org",
        request,
      })
    ).rejects.toEqual(
      new AttestationPreconditionError("invalid_target_origin")
    );
    expect(sign).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...registry, localOwner: "cogni-dao", localZone: "other.org" },
    { ...registry, localOwner: "cogni-test-org", localZone: "" },
    { ...registry, localOwner: "cogni-test-org", localZone: "bad..org" },
    { registryOwner: "cogni-dao" },
    { ...registry, localZone: "example.org" },
  ])("rejects invalid bindings %#", (input) => {
    expect(() => resolveRegisteredFleetZones(input)).toThrow();
  });
});

describe("origin revalidation", () => {
  it("rejects an unmapped owner and rechecks changes before issuance", async () => {
    let owner = "cogni-dao";
    const sign = vi.fn(async () => "signed");
    const broker = createIdentityAttestationService({
      repository: {
        findNode: async () => ({
          nodeId: NODE_ID,
          slug: "toks4",
          repoOwner: owner,
          deployEnvs: ["candidate-a"],
        }),
      },
      signer: { sign },
      clock: { now: () => "2026-08-17T00:00:00.000Z" },
      createJti: () => NODE_ID,
      fleetZoneBindings: resolveRegisteredFleetZones({
        registryOwner: "cogni-dao",
        registryZone: "cognidao.org",
      }),
    });
    await expect(
      broker.resolveNode({ request: REQUEST })
    ).resolves.toMatchObject({ nodeId: NODE_ID });
    owner = "cogni-test-org";
    await expect(
      broker.issue({
        github: AUTHENTICATED_GITHUB,
        issuer: "https://test.cognidao.org",
        request: REQUEST,
      })
    ).rejects.toEqual(
      new AttestationPreconditionError("invalid_target_origin")
    );
    expect(sign).not.toHaveBeenCalled();
  });
  it("rejects environments that were not admitted", async () => {
    await expect(
      service().resolveNode({
        request: {
          ...REQUEST,
          targetOrigin: "https://toks4-preview.cognidao.org",
        },
      })
    ).rejects.toEqual(
      new AttestationPreconditionError("invalid_target_origin")
    );
  });
});

describe("trusted repository metadata", () => {
  it("normalizes the projection owner and refuses mismatched repository metadata", async () => {
    const row = {
      id: NODE_ID,
      slug: "toks4",
      deployEnvs: ["candidate-a"],
      repoOwner: "Cogni-DAO",
      repoUrl: "https://github.com/cogni-dao/toks4",
    };
    const repository = new OperatorIdentityAttestationRepository(
      { listCatalogNodes: async () => [] },
      { parentOwner: "test-projection", parentRepo: "cogni" },
      async () => row
    );
    expect((await repository.findNode(NODE_ID))?.repoOwner).toBe("cogni-dao");
    row.repoUrl = "https://github.com/other/toks4";
    expect((await repository.findNode(NODE_ID))?.repoOwner).toBeNull();
  });
  it("uses the catalog owner's repository metadata on fallback", async () => {
    const catalogNode = {
      nodeId: NODE_ID,
      slug: "toks4",
      deployEnvs: ["candidate-a"],
      repoOwner: "Cogni-DAO",
      repoUrl: "https://github.com/cogni-dao/toks4",
    };
    const repository = new OperatorIdentityAttestationRepository(
      { listCatalogNodes: async () => [catalogNode] } as never,
      { parentOwner: "test-fallback", parentRepo: "cogni" },
      async () => null
    );
    expect((await repository.findNode(NODE_ID))?.repoOwner).toBe("cogni-dao");
  });
});

describe("both fleets on one broker", () => {
  it("accepts each registered zone on entry and issuance and rejects a wrong zone", async () => {
    let owner = "cogni-dao";
    const sign = vi.fn(async () => "signed");
    const broker = createIdentityAttestationService({
      repository: {
        findNode: async () => ({
          nodeId: NODE_ID,
          slug: "toks4",
          repoOwner: owner,
          deployEnvs: ["candidate-a"],
        }),
      },
      signer: { sign },
      clock: { now: () => "2026-08-17T00:00:00.000Z" },
      createJti: () => NODE_ID,
      fleetZoneBindings: resolveRegisteredFleetZones({
        registryOwner: "cogni-dao",
        registryZone: "cognidao.org",
        localOwner: "cogni-test-org",
        localZone: "cogni-testing.org",
      }),
    });
    for (const [fleet, zone] of [
      ["cogni-dao", "cognidao.org"],
      ["cogni-test-org", "cogni-testing.org"],
    ] as const) {
      owner = fleet;
      const request = {
        ...REQUEST,
        targetOrigin: `https://toks4-test.${zone}`,
      };
      await expect(broker.resolveNode({ request })).resolves.toMatchObject({
        nodeId: NODE_ID,
      });
      await expect(
        broker.issue({
          github: AUTHENTICATED_GITHUB,
          issuer: "https://test.cognidao.org",
          request,
        })
      ).resolves.toMatchObject({ attestation: "signed" });
    }
    await expect(broker.resolveNode({ request: REQUEST })).rejects.toEqual(
      new AttestationPreconditionError("invalid_target_origin")
    );
    expect(sign).toHaveBeenCalledTimes(2);
  });
  it("refuses ambiguous injected bindings", async () => {
    const broker = createIdentityAttestationService({
      repository: {
        findNode: async () => ({
          nodeId: NODE_ID,
          slug: "toks4",
          repoOwner: "cogni-dao",
          deployEnvs: ["candidate-a"],
        }),
      },
      signer: { sign: async () => "signed" },
      clock: { now: () => "2026-08-17T00:00:00.000Z" },
      createJti: () => NODE_ID,
      fleetZoneBindings: [
        { fleetOwner: "cogni-dao", zoneName: "cognidao.org" },
        { fleetOwner: "cogni-dao", zoneName: "other.org" },
      ],
    });
    await expect(broker.resolveNode({ request: REQUEST })).rejects.toEqual(
      new AttestationPreconditionError("invalid_target_origin")
    );
  });
});

it("keeps existing lanes observable when the issuer is absent", () => {
  const lanes = resolveEnvLanes({
    deployEnvironment: "production",
    podNamespace: "control",
    secretsNamespace: "cogni-node-deploy-production",
    substrateHost: "substrate.internal",
    operatorDomainRoot: undefined,
    environments: undefined,
    substrateHosts: undefined,
  });
  expect(lanes).toHaveLength(1);
  expect(lanes[0]?.operatorDomain).toBe("");
});
