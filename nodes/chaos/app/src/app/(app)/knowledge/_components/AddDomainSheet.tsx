// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/AddDomainSheet`
 * Purpose: Slide-over Sheet for registering a new knowledge domain via a 3-field form.
 * Scope: Local form state + mutation. Does not contain query-cache invalidation (delegated to caller via onCreated).
 * Side-effects: IO (POST /api/v1/knowledge/domains via createDomain).
 * @internal
 */

"use client";

import type { DomainsCreateResponse } from "@cogni/node-contracts";
import { Plus } from "lucide-react";
import { type ReactElement, useState } from "react";

import {
  Button,
  Input,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components";

import { createDomain } from "../_api/createDomain";

interface AddDomainSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (domain: DomainsCreateResponse) => void;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function AddDomainSheet({
  open,
  onOpenChange,
  onCreated,
}: AddDomainSheetProps): ReactElement {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setId("");
    setName("");
    setDescription("");
    setError(null);
    setSubmitting(false);
  };

  const handleClose = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const idValid = ID_PATTERN.test(id) && id.length >= 2 && id.length <= 64;
  const nameValid = name.trim().length >= 1 && name.length <= 128;
  const canSubmit = idValid && nameValid && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createDomain({
        id,
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      onCreated(created);
      reset();
      onOpenChange(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={handleClose}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="text-lg leading-snug">
            Register a new domain
          </SheetTitle>
          <span className="text-muted-foreground text-xs">
            Domains are sticky — no edit, no delete in v0. Pick a stable id.
          </span>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-5 px-1">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="domain-id"
              className="font-medium text-muted-foreground text-xs uppercase tracking-wider"
            >
              ID
            </label>
            <Input
              id="domain-id"
              className="h-9 font-mono text-sm"
              placeholder="prediction-market"
              value={id}
              onChange={(e) => setId(e.target.value.toLowerCase())}
              autoComplete="off"
              spellCheck={false}
              required
            />
            <span className="text-muted-foreground text-xs">
              Lowercase. <code className="font-mono">[a-z0-9][a-z0-9_-]*</code>{" "}
              · 2–64 chars. Becomes the FK target for every knowledge entry.
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="domain-name"
              className="font-medium text-muted-foreground text-xs uppercase tracking-wider"
            >
              Name
            </label>
            <Input
              id="domain-name"
              className="h-9 text-sm"
              placeholder="Prediction Markets"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={128}
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="domain-description"
              className="font-medium text-muted-foreground text-xs uppercase tracking-wider"
            >
              Description{" "}
              <span className="text-muted-foreground/70 normal-case">
                (optional)
              </span>
            </label>
            <textarea
              id="domain-description"
              className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-[var(--ring-width-sm)] focus-visible:ring-ring"
              placeholder="One-line summary of what this domain covers."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={512}
            />
          </div>

          {error && (
            <p
              className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-xs"
              role="alert"
            >
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-9"
              onClick={() => handleClose(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              className="h-9 gap-1.5"
              disabled={!canSubmit}
            >
              <Plus className="size-3.5" />
              {submitting ? "Registering…" : "Register"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
