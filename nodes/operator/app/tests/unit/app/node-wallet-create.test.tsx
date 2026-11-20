// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/node-wallet-create`
 * Purpose: The wizard's "Create node wallet" control sends ONLY the public key, and only after the
 *   saved recovery file is loaded back and proven (story.0083).
 * Scope: Client component with real WebCrypto (happy-dom) and fetch / download mocked. Also covers the
 *   owner-key round trip the control depends on.
 * Invariants: KEY_STAYS_IN_THE_BROWSER, PROOF_BEFORE_CREATE, NO_STORAGE.
 * Side-effects: none
 * Links: src/features/nodes/wizard/steps/NodeWalletCreate.client.tsx, src/features/nodes/wizard/owner-key.ts
 * @internal
 */

// @vitest-environment happy-dom

import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));
vi.mock("@/components", () => ({
  Button: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly children?: ReactNode;
  }) => <button {...props}>{children}</button>,
}));

import {
  generateOwnerKey,
  loadRecoveryFile,
  proveRecoveryFile,
  recoveryFileName,
} from "@/features/nodes/wizard/owner-key";
import { NodeWalletCreate } from "@/features/nodes/wizard/steps/NodeWalletCreate.client";

const WALLET = "0xdCCa8D85603C2CC47dc6974a790dF846f8695056";

describe("owner-key", () => {
  it("round-trips a recovery file and proves it against the public key", async () => {
    const generated = await generateOwnerKey();
    expect(generated.recoveryPem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    const loaded = await loadRecoveryFile(generated.recoveryPem);
    expect(loaded.spkiBase64).toBe(generated.spkiBase64);
    expect(await proveRecoveryFile(loaded, generated.spkiBase64)).toBe(true);
  });

  it("does not prove a file from a different key", async () => {
    const a = await generateOwnerKey();
    const b = await generateOwnerKey();
    const loadedB = await loadRecoveryFile(b.recoveryPem);
    expect(await proveRecoveryFile(loadedB, a.spkiBase64)).toBe(false);
  });

  it("rejects text that is not a recovery file", async () => {
    await expect(loadRecoveryFile("hello")).rejects.toThrow();
  });

  it("names the file <slug>-wallet-owner.pem", () => {
    expect(recoveryFileName("spawny-boi")).toBe("spawny-boi-wallet-owner.pem");
  });
});

describe("NodeWalletCreate", () => {
  const fetchMock = vi.fn();
  let savedPem = "";

  beforeEach(() => {
    vi.clearAllMocks();
    savedPem = "";
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: (blob: Blob) => {
          void blob.text().then((text) => {
            savedPem = text;
          });
          return "blob:mock";
        },
        revokeObjectURL: () => undefined,
      })
    );
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          walletAddress: WALLET,
          outcome: "created",
          pr: { status: "pr_opened", prUrl: "https://github.com/o/r/pull/1" },
        }),
        { status: 200 }
      )
    );
  });

  function renderControl() {
    return render(
      <NodeWalletCreate
        nodeId="node-1"
        slug="spawny-boi"
        nodeRepoUrl="https://github.com/o/spawny-boi"
        pendingWalletAddress={null}
      />
    );
  }

  it("sends nothing until the saved file is loaded back, then sends only the SPKI public key", async () => {
    const storageSet = vi.spyOn(Storage.prototype, "setItem");
    const { container } = renderControl();

    fireEvent.click(screen.getByRole("button", { name: "Create node wallet" }));
    const input = await waitFor(() => {
      const el = container.querySelector('input[type="file"]');
      if (!el) throw new Error("file input not shown yet");
      return el as HTMLInputElement;
    });
    // key made and the recovery file offered, but NO request yet
    await waitFor(() => expect(savedPem).toContain("BEGIN PRIVATE KEY"));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(input, {
      target: {
        files: [new File([savedPem], "spawny-boi-wallet-owner.pem")],
      },
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/nodes/node-1/node-wallet");
    expect(init.method).toBe("POST");
    const sent = String(init.body);
    expect(Object.keys(JSON.parse(sent))).toEqual(["ownerPublicKey"]);
    expect(sent).not.toContain("PRIVATE");
    // the body is exactly the SPKI of the key in the saved file
    const loaded = await loadRecoveryFile(savedPem);
    expect(JSON.parse(sent).ownerPublicKey).toBe(loaded.spkiBase64);
    // nothing was written to web storage
    expect(storageSet).not.toHaveBeenCalled();

    expect(await screen.findByText(WALLET)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View PR/ })).toHaveAttribute(
      "href",
      "https://github.com/o/r/pull/1"
    );
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("refuses to create when the loaded file is a different key", async () => {
    const { container } = renderControl();
    fireEvent.click(screen.getByRole("button", { name: "Create node wallet" }));
    const input = await waitFor(() => {
      const el = container.querySelector('input[type="file"]');
      if (!el) throw new Error("file input not shown yet");
      return el as HTMLInputElement;
    });
    const other = await generateOwnerKey();
    fireEvent.change(input, {
      target: { files: [new File([other.recoveryPem], "other.pem")] },
    });
    expect(
      await screen.findByText(/does not hold the key made on this page/)
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
