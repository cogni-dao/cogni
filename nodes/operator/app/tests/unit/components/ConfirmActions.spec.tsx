// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Tests native submit gating; browser wire serialization is checked separately.
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmActions } from "@/app/identity/attest/confirm/actions";

const CONFIRM = "Link GitHub";

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

/**
 * Renders the gate and counts real form submissions. jsdom cannot navigate, so the
 * POST is suppressed; the count is what proves a click did — or did not — fire one.
 */
function renderGate(): { form: HTMLFormElement; submits: () => number } {
  let submits = 0;
  render(<ConfirmActions mode="link" />);
  const form = button(CONFIRM).closest("form") as HTMLFormElement;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submits += 1;
  });
  return { form, submits: () => submits };
}

describe("ConfirmActions", () => {
  it("posts to the confirm route, whose only authority is the broker cookie", () => {
    const { form } = renderGate();

    expect(form.getAttribute("action")).toBe("/api/auth/attest/confirm");
    expect(form.getAttribute("method")?.toLowerCase()).toBe("post");
  });

  it.each([
    [CONFIRM, "confirm"],
    ["Switch account", "switch"],
    ["Cancel", "cancel"],
  ])("submits %s as action=%s — ACTION_VALUES_ARE_THE_CONTRACT", (label, value) => {
    renderGate();
    const target = button(label);

    // The real browser fixture checks serialization after this event.
    expect(target.type).toBe("submit");
    expect(target.name).toBe("action");
    expect(target.value).toBe(value);
  });

  it("submits nothing until a human clicks — NO_AUTO_SUBMIT", () => {
    const gate = renderGate();

    expect(gate.submits()).toBe(0);
  });

  it.each([
    [CONFIRM],
    ["Switch account"],
    ["Cancel"],
  ])("keeps %s as submitter and locks other actions", async (label) => {
    const gate = renderGate();
    const selected = button(label);
    const first = new Event("submit", { bubbles: true, cancelable: true });
    Object.defineProperty(first, "submitter", { value: selected });
    fireEvent(gate.form, first);
    expect(gate.submits()).toBe(1);
    expect(selected).toBeEnabled();
    for (const el of screen.getAllByRole("button")) {
      if (el !== selected) expect(el).toBeDisabled();
    }
    expect(
      screen.getByText(/If this page does not change/)
    ).toBeInTheDocument();
    const later = new Event("submit", { bubbles: true, cancelable: true });
    expect(gate.form.dispatchEvent(later)).toBe(false);
  });
});

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "test" }) }),
}));
vi.mock("@/auth", () => ({ authSecret: "test" }));
vi.mock("@/shared/identity/broker-state", () => ({
  BROKER_STATE_COOKIE: "test",
  decodeBrokerState: async () => ({
    github: { id: "123", login: "fixture" },
    nodeSlug: "fixture-node",
    targetOrigin: "https://fixture.cognidao.org",
    returnTo: "https://fixture.cognidao.org/profile",
  }),
}));

describe("confirmation page", () => {
  it("links only to the signed target profile without broker secrets", async () => {
    const { default: Page } = await import(
      "@/app/identity/attest/confirm/page"
    );
    render(await Page());
    const link = screen.getByRole("link", {
      name: "View your profile on fixture-node",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://fixture.cognidao.org/profile"
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(
      screen.getByText(/Link GitHub @fixture to your existing account/)
    ).toBeInTheDocument();
  });
});
