// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/components/NodeRegistrationForm`
 * Purpose: Shared client form for registering an operator-managed node.
 * Scope: Posts to the existing nodes API and routes to the canonical setup page for the new row.
 * Invariants: v0 only supports managed monorepo nodes on Base mainnet.
 * Side-effects: IO (POST /api/v1/nodes)
 * Links: src/app/api/v1/nodes/route.ts, src/app/(app)/setup/nodes/page.tsx
 * @public
 */

"use client";

import { useRouter } from "next/navigation";
import { type ReactElement, useState } from "react";

import { Button, Input } from "@/components";
import { CHAINS as CHAIN_CONFIG_MAP } from "@/shared/web3";

const CHAIN_ID = CHAIN_CONFIG_MAP.BASE.chainId;
const SLUG_RE = /^[a-z][a-z0-9-]{1,31}$/;

export function NodeRegistrationForm(): ReactElement {
  const router = useRouter();
  const [target, setTarget] = useState<"monorepo" | "external">("monorepo");
  const [slug, setSlug] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slugValid = SLUG_RE.test(slug);

  const handleSubmit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/v1/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, chainId: CHAIN_ID }),
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
            value="monorepo"
            checked={target === "monorepo"}
            onChange={() => setTarget("monorepo")}
          />
          Managed node — own repo pinned at <code>nodes/&lt;slug&gt;/</code>
        </label>
        <label className="flex items-center gap-2 text-muted-foreground text-sm">
          <input
            type="radio"
            name="target"
            value="external"
            disabled
            checked={target === "external"}
          />
          Standalone external operator — vNext
        </label>
      </fieldset>

      <div className="space-y-2">
        <label className="font-medium text-sm" htmlFor="slug">
          Node slug
        </label>
        <Input
          id="slug"
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          placeholder="my-node"
        />
        {slug && !slugValid ? (
          <p className="text-destructive text-sm">
            2-32 chars, lowercase letters/numbers/dashes, starts with a letter
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <span className="font-medium text-sm">Chain</span>
        <p className="text-muted-foreground text-sm">
          Base mainnet ({CHAIN_ID}) — the only supported chain in v0.
        </p>
      </div>

      {error ? <p className="text-destructive text-sm">{error}</p> : null}

      <Button
        onClick={handleSubmit}
        disabled={submitting || target !== "monorepo" || !slugValid}
      >
        {submitting ? "Registering..." : "Register node"}
      </Button>
    </div>
  );
}
