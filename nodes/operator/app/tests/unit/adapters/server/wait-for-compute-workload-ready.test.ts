// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  readLive: vi.fn(),
  version: vi.fn(),
  parseArgs: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("node:util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:util")>()),
  parseArgs: mocks.parseArgs,
  promisify: () => mocks.readLive,
}));
vi.mock("../../../../src/adapters/server/compute/safe-version-probe", () => ({
  safeVersionProbeResult: mocks.version,
}));

import { main } from "../../../../scripts/wait-for-compute-workload-ready";

const sourceSha = "f9b061768637683ca8a278c1f6cc5079c751be89";

function fixture(publicHost: unknown = "poly-preview.cognidao.org") {
  const bundle = {
    ref: `ghcr.io/cogni-dao/poly@sha256:${"a".repeat(64)}`,
    source: { repository: "cogni-dao/poly", sha: sourceSha },
  };
  return {
    apiVersion: "compute.cogni.io/v1alpha1",
    kind: "XComputeWorkload",
    metadata: { name: "poly", namespace: "cogni-preview", generation: 42 },
    spec: { bundle, workload: { publicHost } },
    // This is the incident: all native fields name the requested revision and
    // claim Ready, while public traffic is still on the preceding application.
    status: {
      phase: "Ready",
      serving: true,
      observedBundle: bundle,
      conditions: ["Ready", "Synced"].map((type) => ({
        type,
        status: "True",
        observedGeneration: 42,
      })),
    },
  };
}

function setManifest(manifest: unknown) {
  mocks.readFile.mockResolvedValue(JSON.stringify(manifest));
  mocks.readLive.mockResolvedValue({ stdout: JSON.stringify(manifest) });
}

describe("compute readiness CLI public revision gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.clearAllMocks();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    mocks.parseArgs.mockReturnValue({
      values: {
        "manifest-json": "/expected.json",
        host: "control.example.org",
        identity: "/identity",
        "timeout-seconds": "12",
      },
    });
    setManifest(fixture());
    mocks.version.mockResolvedValue("matched");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps early Ready in the original wait until the public SHA matches", async () => {
    mocks.version
      .mockResolvedValueOnce("source_mismatch")
      .mockResolvedValueOnce("version_unavailable")
      .mockResolvedValue("matched");
    const completed = vi.fn();
    const wait = main().then(completed);

    await vi.advanceTimersByTimeAsync(0);
    expect(completed).not.toHaveBeenCalled();
    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining("public_source_mismatch; waiting")
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    await wait;

    expect(completed).toHaveBeenCalledOnce();
    expect(mocks.version).toHaveBeenLastCalledWith(
      "https://poly-preview.cognidao.org",
      sourceSha,
      2_000
    );
    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining(`public buildSha=${sourceSha}`)
    );
  });

  it.each([
    "source_mismatch",
    "version_unavailable",
  ])("fails within the same deadline when public proof remains %s", async (reason) => {
    mocks.version.mockResolvedValue(reason);
    const failure = expect(main()).rejects.toThrow(`public_${reason}`);
    await vi.advanceTimersByTimeAsync(12_000);
    await failure;
    expect(Date.now()).toBe(12_000);
    expect(mocks.version).toHaveBeenCalledTimes(3);
    expect(mocks.readLive).toHaveBeenLastCalledWith(
      "ssh",
      expect.any(Array),
      expect.objectContaining({ timeout: 2_000 })
    );
  });

  it("bounds a stuck DNS/probe and retries without restarting the wait budget", async () => {
    mocks.version.mockImplementation(() => new Promise(() => {}));
    const failure = expect(main()).rejects.toThrow(
      "public_version_unavailable"
    );
    await vi.advanceTimersByTimeAsync(12_000);
    await failure;
    expect(Date.now()).toBe(12_000);
    expect(mocks.version).toHaveBeenCalledTimes(2);
    expect(mocks.version).toHaveBeenLastCalledWith(
      "https://poly-preview.cognidao.org",
      sourceSha,
      2_000
    );
  });

  it("treats probe errors as unproven rather than successful", async () => {
    mocks.version.mockRejectedValue(new Error("connection reset"));
    const failure = expect(main()).rejects.toThrow(
      "public_version_unavailable"
    );
    await vi.advanceTimersByTimeAsync(12_000);
    await failure;
  });

  it("still requires native readiness even when the public SHA is correct", async () => {
    const manifest = fixture();
    setManifest({
      ...manifest,
      status: { ...manifest.status, serving: false },
    });
    const failure = expect(main()).rejects.toThrow("not_serving");
    await vi.advanceTimersByTimeAsync(12_000);
    await failure;
    expect(mocks.version).not.toHaveBeenCalled();
  });

  it("retains native-only readiness for a workload without publicHost", async () => {
    const manifest = fixture();
    setManifest({ ...manifest, spec: { ...manifest.spec, workload: {} } });
    await main();
    expect(mocks.version).not.toHaveBeenCalled();
    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining("Ready at current generation")
    );
  });

  it("public-only waits for the manifest SHA without an SSH host or identity", async () => {
    mocks.parseArgs.mockReturnValue({
      values: {
        "manifest-json": "/expected.json",
        "timeout-seconds": "12",
        "public-only": true,
      },
    });
    mocks.version
      .mockResolvedValueOnce("source_mismatch")
      .mockResolvedValue("matched");
    const completed = vi.fn();
    const wait = main().then(completed);
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).not.toHaveBeenCalled();
    expect(mocks.readLive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    await wait;
    expect(completed).toHaveBeenCalledOnce();
    expect(mocks.readLive).not.toHaveBeenCalled();
    expect(mocks.version).toHaveBeenCalledWith(
      "https://poly-preview.cognidao.org",
      sourceSha,
      5_000
    );
    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining("Public revision verified")
    );
    expect(process.stdout.write).not.toHaveBeenCalledWith(
      expect.stringContaining("Ready at current generation")
    );
  });

  it("public-only fails closed within its budget when no revision can be read", async () => {
    mocks.parseArgs.mockReturnValue({
      values: {
        "manifest-json": "/expected.json",
        "timeout-seconds": "12",
        "public-only": true,
      },
    });
    mocks.version.mockImplementation(() => new Promise(() => {}));
    const failure = expect(main()).rejects.toThrow(
      "public_version_unavailable"
    );
    await vi.advanceTimersByTimeAsync(12_000);
    await failure;
    expect(Date.now()).toBe(12_000);
    expect(mocks.readLive).not.toHaveBeenCalled();
  });

  it.each([
    "missing host",
    "missing source",
  ])("public-only refuses %s instead of passing a native-only no-op", async (missing) => {
    mocks.parseArgs.mockReturnValue({
      values: {
        "manifest-json": "/expected.json",
        "timeout-seconds": "12",
        "public-only": true,
      },
    });
    const manifest = fixture();
    setManifest({
      ...manifest,
      spec: {
        ...manifest.spec,
        ...(missing === "missing host"
          ? { workload: {} }
          : { bundle: { ref: manifest.spec.bundle.ref } }),
      },
    });
    await expect(main()).rejects.toThrow(
      missing === "missing host" ? "publicHost" : "full commit SHA"
    );
    expect(mocks.readLive).not.toHaveBeenCalled();
    expect(mocks.version).not.toHaveBeenCalled();
  });

  it.each([
    "https://example.org",
    "127.0.0.1",
    "localhost",
    "node.local",
    "example.org/path",
    "",
    null,
  ])("rejects malformed publicHost %s before any network read", async (publicHost) => {
    setManifest(fixture(publicHost));
    await expect(main()).rejects.toThrow("must be a public DNS hostname");
    expect(mocks.readLive).not.toHaveBeenCalled();
    expect(mocks.version).not.toHaveBeenCalled();
  });

  it.each([
    "f9b06176",
    "",
    undefined,
  ])("rejects missing/abbreviated source SHA %s before any network read", async (sha) => {
    const manifest = fixture();
    setManifest({
      ...manifest,
      spec: {
        ...manifest.spec,
        bundle: { ...manifest.spec.bundle, source: { sha } },
      },
    });
    await expect(main()).rejects.toThrow("must be a full commit SHA");
    expect(mocks.readLive).not.toHaveBeenCalled();
    expect(mocks.version).not.toHaveBeenCalled();
  });
});
