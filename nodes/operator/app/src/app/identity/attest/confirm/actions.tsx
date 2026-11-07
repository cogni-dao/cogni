"use client";

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/identity/attest/confirm/actions`
 * Purpose: The three terminal actions on the account-intent gate, with a real pending
 *   state — submitting posts a full navigation, so without this the screen sits inert
 *   after the click and reads as broken.
 * Scope: Presentation + submit state only. Decides nothing; the server route owns every
 *   outcome.
 * Invariants:
 *   - NO_AUTO_SUBMIT: nothing fires without a human click. This screen is the account
 *     intent gate (task.5024); an auto-submit would defeat its entire purpose.
 *   - ONE_SUBMIT: guard later submissions while preserving the native submitter.
 * Side-effects: navigation (form POST)
 * @public
 */

import { Spinner } from "@cogni/node-ui-kit/shadcn/spinner";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components";

export function ConfirmActions({
  mode,
  consentBinding,
}: {
  mode: "signin" | "link";
  consentBinding: string;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const submitted = useRef(false);

  useEffect(() => {
    const revalidate = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.replace("/identity/attest/confirm");
    };
    window.addEventListener("pageshow", revalidate);
    return () => window.removeEventListener("pageshow", revalidate);
  }, []);

  return (
    <form
      action="/api/auth/attest/confirm"
      aria-busy={pending !== null}
      className="flex w-full flex-col gap-2"
      method="post"
      onSubmit={(e) => {
        if (submitted.current) {
          e.preventDefault();
          return;
        }
        submitted.current = true;
        const submitter = (e.nativeEvent as SubmitEvent).submitter;
        setPending(
          submitter instanceof HTMLButtonElement ? submitter.value : "none"
        );
      }}
    >
      <input type="hidden" name="consentBinding" value={consentBinding} />
      <Button
        className="w-full"
        disabled={pending !== null && pending !== "confirm"}
        name="action"
        type="submit"
        value="confirm"
      >
        {pending === "confirm" ? <Spinner /> : null}
        {mode === "signin" ? "Continue" : "Link GitHub"}
      </Button>
      <Button
        className="w-full"
        disabled={pending !== null && pending !== "switch"}
        name="action"
        type="submit"
        value="switch"
        variant="ghost"
      >
        {pending === "switch" ? <Spinner /> : null}
        Use a different GitHub account
      </Button>
      <Button
        className="w-full"
        disabled={pending !== null && pending !== "cancel"}
        name="action"
        type="submit"
        value="cancel"
        variant="ghost"
      >
        {pending === "cancel" ? <Spinner /> : null}
        Cancel
      </Button>
      {pending !== null ? (
        <output className="text-muted-foreground text-sm">
          Continuing. If this page does not change, reload it or start again
          from your node.
        </output>
      ) : null}
    </form>
  );
}
