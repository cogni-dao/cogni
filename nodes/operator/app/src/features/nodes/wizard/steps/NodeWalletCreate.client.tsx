// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/steps/NodeWalletCreate.client`
 * Purpose: The wizard's "Create node wallet" control (story.0083). The node owner's browser makes a
 *   P-256 owner key, saves it as a recovery file, proves the file by loading it back, and only then
 *   asks the operator to create the wallet by sending the PUBLIC key.
 * Scope: One control. The private key lives only in local variables inside the click handlers and in the
 *   downloaded file; component state and refs hold the public key and status text only.
 * Invariants:
 *   - KEY_STAYS_IN_THE_BROWSER: the request body is exactly `{ ownerPublicKey }` (base64 SPKI).
 *   - NO_STORAGE: nothing is written to localStorage / sessionStorage / IndexedDB.
 *   - PROOF_BEFORE_CREATE: no request is sent until the loaded file signs a challenge that verifies
 *     against the public key made on this page (or, for "use an existing file", the file's own key).
 *   - NO_THIRD_PARTY_SCRIPT: this control loads nothing; the route is served with a strict CSP.
 * Side-effects: IO (file download, file read, POST /api/v1/nodes/{id}/node-wallet)
 * Links: src/features/nodes/wizard/owner-key.ts, src/app/api/v1/nodes/[id]/node-wallet/route.ts,
 *   https://node-template.cognidao.org/knowledge/set-up-operator-wallet
 * @public
 */

"use client";

import { ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ChangeEvent, ReactElement } from "react";
import { useRef, useState } from "react";

import { Button } from "@/components";

import {
  generateOwnerKey,
  loadRecoveryFile,
  proveRecoveryFile,
  recoveryFileName,
} from "../owner-key";

type Phase = "IDLE" | "AWAIT_FILE" | "WORKING" | "DONE" | "ERROR";

interface NodeWalletResponse {
  readonly error?: unknown;
  readonly reason?: unknown;
  readonly walletAddress?: unknown;
  readonly pr?: { readonly prUrl?: unknown; readonly status?: unknown };
}

function describeError(status: number, body: NodeWalletResponse): string {
  switch (body.error) {
    case "key_mismatch":
      return "This node already has a wallet owned by a different key. Use the original recovery file for this node.";
    case "already_has_wallet":
      return "This node already has a wallet. Read the node repo-spec below to continue.";
    case "privy_unconfigured":
      return "This operator is not configured to create wallets yet (Privy).";
    case "pr_open_failed":
      return "The wallet was created, but the repo-spec PR could not be opened. Load the same recovery file to try again.";
    case "origin_mismatch":
    case "session_required":
    case "unauthorized":
      return "Sign in to the operator as the node owner in this browser, then try again.";
    case "not_node_owner":
      return "Only the node owner who registered this node can create its wallet.";
    default:
      return typeof body.reason === "string"
        ? body.reason
        : typeof body.error === "string"
          ? body.error
          : `HTTP ${status}`;
  }
}

export function NodeWalletCreate({
  nodeId,
  slug,
  nodeRepoUrl,
  pendingWalletAddress,
}: {
  readonly nodeId: string;
  readonly slug: string;
  readonly nodeRepoUrl: string | null;
  readonly pendingWalletAddress: string | null;
}): ReactElement {
  const router = useRouter();
  // The PUBLIC key made on this page. Null on the "use an existing file" path. Never the private key.
  const expectedSpkiRef = useRef<string | null>(null);
  const requestInFlightRef = useRef(false);
  const [phase, setPhase] = useState<Phase>("IDLE");
  const [message, setMessage] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(
    pendingWalletAddress
  );
  const [prUrl, setPrUrl] = useState<string | null>(null);

  const startCreate = async () => {
    setMessage(null);
    try {
      const generated = await generateOwnerKey();
      expectedSpkiRef.current = generated.spkiBase64;
      const url = URL.createObjectURL(
        new Blob([generated.recoveryPem], { type: "application/x-pem-file" })
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = recoveryFileName(slug);
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Safari and Firefox can drop the download if the URL is revoked in the same tick.
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setPhase("AWAIT_FILE");
    } catch {
      setMessage("Could not make a key in this browser.");
      setPhase("ERROR");
    }
  };

  const useExistingFile = () => {
    expectedSpkiRef.current = null;
    setMessage(null);
    setPhase("AWAIT_FILE");
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file || requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    setPhase("WORKING");
    setMessage(null);
    try {
      const loaded = await loadRecoveryFile(await file.text());
      const expected = expectedSpkiRef.current ?? loaded.spkiBase64;
      const proven = await proveRecoveryFile(loaded, expected);
      if (!proven) {
        setMessage(
          "That file does not hold the key made on this page. Load the file you just saved."
        );
        setPhase("AWAIT_FILE");
        return;
      }
      const response = await fetch(`/api/v1/nodes/${nodeId}/node-wallet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerPublicKey: expected }),
      });
      let body: NodeWalletResponse = {};
      try {
        const parsed: unknown = JSON.parse(await response.text());
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          body = parsed as NodeWalletResponse;
        }
      } catch {
        // Non-JSON body: the HTTP status is reported below.
      }
      if (typeof body.walletAddress === "string") {
        setWalletAddress(body.walletAddress);
      }
      if (!response.ok) {
        setMessage(describeError(response.status, body));
        setPhase(body.error === "pr_open_failed" ? "AWAIT_FILE" : "ERROR");
        return;
      }
      if (typeof body.pr?.prUrl === "string") setPrUrl(body.pr.prUrl);
      expectedSpkiRef.current = null;
      setPhase("DONE");
      router.refresh();
    } catch {
      setMessage("That file is not a valid recovery file.");
      setPhase("AWAIT_FILE");
    } finally {
      requestInFlightRef.current = false;
    }
  };

  const pullsUrl = nodeRepoUrl ? `${nodeRepoUrl}/pulls` : null;

  if (phase === "DONE" || (phase === "IDLE" && walletAddress)) {
    return (
      <div className="space-y-2 rounded-md border border-border bg-muted/40 p-4 text-sm">
        <p className="font-medium">Node wallet created</p>
        <p>
          <span className="font-medium">Address:</span>{" "}
          <code className="break-all text-xs">{walletAddress}</code>
        </p>
        <p className="text-muted-foreground">
          Merge the repo-spec PR in the node repo, then read the node repo-spec
          below. Keep <code>{recoveryFileName(slug)}</code> safe: it owns the
          wallet.
        </p>
        {!prUrl ? (
          <div className="space-y-2">
            <p className="text-muted-foreground">
              Not sure the PR was opened? Load the recovery file again and the
              operator opens it (or finds the open one).
            </p>
            <Button type="button" variant="outline" onClick={useExistingFile}>
              Load recovery file to open the PR
            </Button>
          </div>
        ) : null}
        {(prUrl ?? pullsUrl) ? (
          <a
            href={prUrl ?? pullsUrl ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-primary hover:underline"
          >
            {prUrl ? "View PR" : "Open node repo pull requests"}
            <ExternalLink className="size-3.5" />
          </a>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-4">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="space-y-1">
          <p className="font-medium">Create node wallet</p>
          <p className="text-muted-foreground">
            Your browser makes a key and saves it as{" "}
            <code>{recoveryFileName(slug)}</code>. The operator never sees it:
            only the public half is sent. Whoever holds that file owns the
            wallet, so keep it somewhere safe. If it is lost, the wallet cannot
            be recovered by the operator.
          </p>
        </div>
      </div>

      {phase === "AWAIT_FILE" ? (
        <label className="block space-y-1">
          <span className="font-medium">
            {expectedSpkiRef.current
              ? "Load the saved file back to confirm it works"
              : "Load the recovery file for this node"}
          </span>
          <input
            type="file"
            accept=".pem,application/x-pem-file,text/plain"
            onChange={onFile}
            className="block w-full text-sm"
          />
        </label>
      ) : null}

      {phase === "WORKING" ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Checking the file and creating the wallet...
        </div>
      ) : null}

      {message ? (
        <p className="text-destructive" role="alert">
          {message}
        </p>
      ) : null}

      {phase === "IDLE" || phase === "ERROR" ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" onClick={startCreate} className="gap-2">
            Create node wallet
          </Button>
          <Button type="button" variant="outline" onClick={useExistingFile}>
            I already have a recovery file
          </Button>
        </div>
      ) : null}
    </div>
  );
}
