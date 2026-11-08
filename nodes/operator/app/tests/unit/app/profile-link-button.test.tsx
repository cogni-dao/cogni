// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/profile-link-button`
 * Purpose: bug.5603 — a double click issues one link request, and the callbackUrl never claims success.
 * Scope: Renders the profile Link button with mocked fetch and NextAuth signIn.
 * @vitest-environment happy-dom
 * @internal
 */

import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signIn = vi.hoisted(() => vi.fn());
vi.mock("next-auth/react", () => ({ signIn }));
vi.mock("@/components", () => ({
  Button: (props: React.ComponentProps<"button">) => (
    <button type="button" {...props} />
  ),
}));

import { LinkProviderButton } from "@/app/(app)/profile/LinkProviderButton";

describe("LinkProviderButton", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue({ ok: true });
    signIn.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("issues exactly one link request and one sign-in on a double click", async () => {
    render(<LinkProviderButton provider="github" />);
    const button = screen.getByRole("button", { name: "Link" });

    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/link/github", {
      method: "POST",
    });
  });

  it("passes a neutral callbackUrl that does not claim success", async () => {
    render(<LinkProviderButton provider="github" />);
    fireEvent.click(screen.getByRole("button", { name: "Link" }));

    await waitFor(() => expect(signIn).toHaveBeenCalled());
    const [, options] = signIn.mock.calls[0] as [
      string,
      { callbackUrl: string },
    ];
    expect(options.callbackUrl).toBe("/profile");
    expect(options.callbackUrl).not.toContain("linked");
  });

  it("re-enables after a failed link request so the user can retry", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });
    render(<LinkProviderButton provider="github" />);
    const button = screen.getByRole("button", { name: "Link" });

    fireEvent.click(button);
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(signIn).not.toHaveBeenCalled();

    fireEvent.click(button);
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
  });
});
