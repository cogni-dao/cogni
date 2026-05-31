// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/setup/nodes/NewNodeForm.client`
 * Purpose: Form to register a new monorepo-internal node. Calls POST /api/v1/nodes with a slug + chain
 *   and routes the user to the dashboard for the freshly-created row.
 * Scope: Pure client form. v0 nodes live at `nodes/<slug>/` in the Cogni-DAO/cogni monorepo. The
 *   "standalone external repo" option is rendered disabled with a vNext label.
 * Links: task.5083
 * @public
 */

"use client";

import { useRouter } from "next/navigation";
import { type ReactElement, useState } from "react";

import { Button, Input } from "@/components";
import { CHAINS as CHAIN_CONFIG_MAP } from "@/shared/web3";

// v0 supports Base mainnet only. Keep chain fixed to reduce axes of freedom.
const CHAIN_ID = CHAIN_CONFIG_MAP.BASE.chainId;

const SLUG_RE = /^[a-z][a-z0-9-]{1,31}$/;

export function NewNodeForm(): ReactElement {
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
          Monorepo node — lives at <code>nodes/&lt;slug&gt;/</code> in
          Cogni-DAO/cogni
        </label>
        <label className="flex items-center gap-2 text-muted-foreground text-sm">
          <input
            type="radio"
            name="target"
            value="external"
            disabled
            checked={target === "external"}
          />
          Standalone external repo — vNext
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
        {submitting ? "Registering…" : "Register node"}
      </Button>
    </div>
  );
}
