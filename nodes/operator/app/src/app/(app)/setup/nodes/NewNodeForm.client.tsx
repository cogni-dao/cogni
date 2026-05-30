// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/setup/nodes/NewNodeForm.client`
 * Purpose: Form to register a new external-repo node. Calls POST /api/v1/nodes and routes the user
 *   to the dashboard for the freshly-created row.
 * Scope: Pure client form. Only v0 target choice is exposed; the "node-template fork in this monorepo"
 *   radio is rendered disabled with a vNext label to signal upcoming work.
 * Links: task.5083
 * @public
 */

"use client";

import { useRouter } from "next/navigation";
import { type ReactElement, useState } from "react";

import { Button, Input } from "@/components";
import { CHAINS as CHAIN_CONFIG_MAP } from "@/shared/web3";

const CHAIN_OPTIONS: ReadonlyArray<{ id: number; label: string }> = [
  {
    id: CHAIN_CONFIG_MAP.BASE.chainId,
    label: `Base mainnet (${CHAIN_CONFIG_MAP.BASE.chainId})`,
  },
  {
    id: CHAIN_CONFIG_MAP.SEPOLIA.chainId,
    label: `Sepolia (${CHAIN_CONFIG_MAP.SEPOLIA.chainId})`,
  },
];

export function NewNodeForm(): ReactElement {
  const router = useRouter();
  const [target, setTarget] = useState<"external" | "monorepo">("external");
  const [repoUrl, setRepoUrl] = useState("https://github.com/Cogni-DAO/poly");
  const [chainId, setChainId] = useState<number>(CHAIN_CONFIG_MAP.BASE.chainId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/v1/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl, chainId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.reason ?? body?.error ?? `HTTP ${res.status}`);
        return;
      }
      const { node } = await res.json();
      router.push(`/setup/nodes/${node.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="font-medium text-sm">Target</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="target"
            value="external"
            checked={target === "external"}
            onChange={() => setTarget("external")}
          />
          External repo (public; cogni-node-template GitHub App must be
          installed)
        </label>
        <label className="flex items-center gap-2 text-muted-foreground text-sm">
          <input
            type="radio"
            name="target"
            value="monorepo"
            disabled
            checked={target === "monorepo"}
          />
          node-template fork in this monorepo — vNext
        </label>
      </fieldset>

      <div className="space-y-2">
        <label className="font-medium text-sm" htmlFor="repoUrl">
          Repository URL
        </label>
        <Input
          id="repoUrl"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder="https://github.com/<owner>/<repo>"
        />
      </div>

      <div className="space-y-2">
        <label className="font-medium text-sm" htmlFor="chainId">
          Chain
        </label>
        <select
          id="chainId"
          className="block rounded border border-border bg-background px-3 py-2 text-sm"
          value={chainId}
          onChange={(e) => setChainId(Number(e.target.value))}
        >
          {CHAIN_OPTIONS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      {error ? <p className="text-destructive text-sm">{error}</p> : null}

      <Button
        onClick={handleSubmit}
        disabled={submitting || target !== "external" || !repoUrl}
      >
        {submitting ? "Registering…" : "Register node"}
      </Button>
    </div>
  );
}
