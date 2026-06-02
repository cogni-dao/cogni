// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/profile/view`
 * Purpose: Client component for user profile settings — display name, avatar color, and linked accounts.
 * Scope: Reads/updates user profile via /api/v1/users/me; does not handle OAuth flow directly or manage session persistence.
 * Invariants: Requires authenticated session (enforced by parent layout); avatar color updates reflected in session via update().
 * Side-effects: IO (fetch API, session update, navigation for OAuth linking)
 * Links: src/contracts/users.profile.v1.contract.ts, src/app/api/v1/users/me/route.ts
 * @public
 */

"use client";

import { useConnectModal } from "@rainbow-me/rainbowkit";
import { Check, Server as ServerIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn, useSession } from "next-auth/react";
import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  Avatar,
  AvatarFallback,
  Button,
  DiscordIcon,
  EthereumIcon,
  GitHubIcon,
  GoogleIcon,
  PageContainer,
} from "@/components";
import { OpenAIIcon } from "@/features/ai/icons/providers/OpenAIIcon";

/* ─── Types ────────────────────────────────────────────────────────── */

interface LinkedProvider {
  provider: "wallet" | "discord" | "github" | "google";
  providerLogin: string | null;
}

interface ProfileData {
  displayName: string | null;
  avatarColor: string | null;
  resolvedDisplayName: string;
  linkedProviders: LinkedProvider[];
}

interface OwnershipAttribution {
  epochId: string;
  epochStatus: "open" | "review" | "finalized";
  subjectRef: string;
  source: string | null;
  eventType: string | null;
  units: string;
  matchedBy: string;
  eventTime: string | null;
  artifactUrl: string | null;
}

interface OwnershipSummary {
  totalUnits: string;
  finalizedUnits: string;
  pendingUnits: string;
  finalizedSharePercent: number;
  epochsMatched: number;
  matchedAttributionCount: number;
  linkedIdentityCount: number;
  recentAttributions: OwnershipAttribution[];
}

/* ─── Preset avatar color palette ─────────────────────────────────── */

const AVATAR_COLORS = [
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#a855f7", // purple
  "#ec4899", // pink
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#6b7280", // gray
] as const;

/* ─── OAuth provider config for linked accounts ───────────────────── */

const OAUTH_PROVIDERS = [
  {
    id: "github" as const,
    label: "GitHub",
    description: "Link your GitHub account.",
    Icon: GitHubIcon,
  },
  {
    id: "discord" as const,
    label: "Discord",
    description: "Link your Discord account.",
    Icon: DiscordIcon,
  },
  {
    id: "google" as const,
    label: "Google",
    description: "Link your Google account.",
    Icon: GoogleIcon,
  },
];

/* ─── Layout primitives ───────────────────────────────────────────── */

function SectionHeading({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="pt-8 pb-2 first:pt-0">
      <h2 className="font-semibold text-foreground text-lg">{children}</h2>
      <div className="mt-2 border-border border-b" />
    </div>
  );
}

function SettingRow({
  icon,
  label,
  description,
  children,
}: {
  icon?: ReactNode;
  label: string;
  description?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <>
      <div className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {icon && (
            <div className="flex shrink-0 items-center justify-center text-muted-foreground">
              {icon}
            </div>
          )}
          <div className="min-w-0">
            <div className="font-medium text-foreground text-sm">{label}</div>
            {description && (
              <div className="text-muted-foreground text-sm">{description}</div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      </div>
      <div className="border-border border-b last:border-b-0" />
    </>
  );
}

function ConnectedBadge({ login }: { login: string }): ReactElement {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-sm">{login}</span>
      <span className="flex size-5 items-center justify-center rounded-full bg-primary/15 text-primary">
        <Check className="size-3" strokeWidth={3} />
      </span>
    </div>
  );
}

function formatUnits(units: string): string {
  const value = Number(units);
  if (!Number.isFinite(value)) return units;
  return value.toLocaleString();
}

/* ─── Feedback banner ──────────────────────────────────────────────── */

const FEEDBACK_MESSAGES: Record<
  string,
  { text: string; variant: "success" | "error" }
> = {
  already_linked: {
    text: "That account is already linked to a different user.",
    variant: "error",
  },
  link_failed: {
    text: "Account linking failed. Please try again.",
    variant: "error",
  },
};

function FeedbackBanner({
  linkedProvider,
  error,
}: {
  linkedProvider: string | null;
  error: string | null;
}): ReactElement | null {
  if (linkedProvider) {
    return (
      <div className="rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-foreground text-sm">
        Successfully linked your {linkedProvider} account.
      </div>
    );
  }
  if (error) {
    const msg = FEEDBACK_MESSAGES[error];
    if (msg) {
      return (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-foreground text-sm">
          {msg.text}
        </div>
      );
    }
  }
  return null;
}

/* ─── Color picker swatch ─────────────────────────────────────────── */

function ColorPickerSwatch({
  colors,
  selected,
  onSelect,
}: {
  colors: readonly string[];
  selected: string;
  onSelect: (color: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open, handleClickOutside]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="size-8 cursor-pointer rounded-full outline outline-2 outline-ring outline-offset-2 transition-transform hover:scale-110"
        style={{ backgroundColor: selected }}
        aria-label="Change avatar color"
      />
      {open && (
        <div className="absolute top-full right-0 z-50 mt-2 rounded-lg border border-border bg-popover p-3 shadow-md">
          <div className="grid grid-cols-6 gap-3">
            {colors.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => {
                  onSelect(color);
                  setOpen(false);
                }}
                className={`size-8 cursor-pointer rounded-full transition-all ${
                  selected === color
                    ? "outline outline-2 outline-ring outline-offset-2"
                    : "hover:scale-110"
                }`}
                style={{ backgroundColor: color }}
                aria-label={`Select color ${color}`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── ChatGPT Connect Flow (Device Code) ─────────────────────────── */

/**
 * ChatGPT Device Code connect flow.
 *
 * Immediately starts the device code flow on mount (no idle phase).
 * Shows a stepped walkthrough: get code → open OpenAI → enter code → wait.
 */
function ChatGptConnectFlow({
  onComplete,
  onCancel,
}: {
  onComplete: () => void;
  onCancel: () => void;
}): ReactElement {
  const [phase, setPhase] = useState<"loading" | "code" | "error">("loading");
  const [deviceAuth, setDeviceAuth] = useState<{
    deviceAuthId: string;
    userCode: string;
    interval: number;
    verificationUrl: string;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [codeCopied, setCodeCopied] = useState(false);
  const startedRef = useRef(false);

  // Start device code flow immediately on mount
  const startFlow = useCallback(async () => {
    setPhase("loading");
    setErrorMsg("");
    setCodeCopied(false);
    try {
      const res = await fetch("/api/v1/auth/openai-codex/authorize", {
        method: "POST",
      });
      if (!res.ok) {
        setPhase("error");
        setErrorMsg("Failed to start authentication");
        return;
      }
      const data = await res.json();
      setDeviceAuth(data);
      setPhase("code");
    } catch {
      setPhase("error");
      setErrorMsg("Failed to connect to server");
    }
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void startFlow();
  }, [startFlow]);

  // Poll for authorization when in "code" phase
  useEffect(() => {
    if (phase !== "code" || !deviceAuth) return;

    let cancelled = false;
    const pollInterval = (deviceAuth.interval || 5) * 1000;
    let elapsed = 0;
    const maxWait = 15 * 60 * 1000; // 15 minutes

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch("/api/v1/auth/openai-codex/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deviceAuthId: deviceAuth.deviceAuthId,
            userCode: deviceAuth.userCode,
          }),
        });
        const data = await res.json();
        if (cancelled) return;

        if (data.status === "connected") {
          onComplete();
          return;
        }
        if (data.status === "pending") {
          elapsed += pollInterval;
          if (elapsed >= maxWait) {
            setPhase("error");
            setErrorMsg("Timed out waiting for authorization");
            return;
          }
          timer = setTimeout(poll, pollInterval);
          return;
        }
        // Error
        setPhase("error");
        setErrorMsg(data.error || "Authorization failed");
      } catch {
        if (!cancelled) {
          setPhase("error");
          setErrorMsg("Connection error");
        }
      }
    };

    let timer: ReturnType<typeof setTimeout> = setTimeout(poll, pollInterval);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, deviceAuth, onComplete]);

  if (phase === "error") {
    return (
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        {errorMsg && <div className="text-destructive text-sm">{errorMsg}</div>}
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              startedRef.current = false;
              void startFlow();
            }}
          >
            Try again
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4">
        <span className="animate-pulse text-muted-foreground">●</span>
        <span className="text-muted-foreground text-sm">
          Starting authentication...
        </span>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    );
  }

  // phase === "code" — stepped walkthrough
  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      {/* Warning */}
      <div className="flex gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
        <span className="shrink-0 text-warning">&#9888;</span>
        <span className="text-muted-foreground text-sm">
          You may need to enable <strong>Device Code Authorization</strong> in
          your{" "}
          <a
            href="https://platform.openai.com/settings/authentication"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            OpenAI account settings
          </a>{" "}
          first.
        </span>
      </div>

      {/* Step 1: Open OpenAI */}
      <div className="space-y-2">
        <div className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
          Step 1 — Open OpenAI
        </div>
        <Button variant="outline" size="sm" asChild>
          <a
            href={deviceAuth?.verificationUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open OpenAI sign-in page &#8599;
          </a>
        </Button>
      </div>

      {/* Step 2: Copy & enter code */}
      <div className="space-y-2">
        <div className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
          Step 2 — Enter this code
        </div>
        <div className="flex items-center gap-3">
          <code className="rounded-md border border-border bg-muted px-4 py-2 font-mono text-xl tracking-widest">
            {deviceAuth?.userCode}
          </code>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (deviceAuth?.userCode) {
                navigator.clipboard.writeText(deviceAuth.userCode);
                setCodeCopied(true);
                setTimeout(() => setCodeCopied(false), 2000);
              }
            }}
          >
            {codeCopied ? "Copied!" : "Copy"}
          </Button>
        </div>
      </div>

      {/* Step 3: Waiting */}
      <div className="space-y-1.5">
        <div className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
          Step 3 — Wait for confirmation
        </div>
        <div className="flex items-center gap-2">
          <span className="animate-pulse text-primary">●</span>
          <span className="text-muted-foreground text-sm">
            Waiting for authorization...
          </span>
        </div>
      </div>

      <div className="border-border border-t pt-3">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ─── View ─────────────────────────────────────────────────────────── */

export function ProfileView(): ReactElement {
  const { data: session, update: updateSession } = useSession();
  const { openConnectModal } = useConnectModal();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [ownership, setOwnership] = useState<OwnershipSummary | null>(null);
  const [selectedColor, setSelectedColor] = useState("#6366f1");
  const [configuredProviders, setConfiguredProviders] = useState<Set<string>>(
    new Set()
  );
  const [chatGptConnected, setChatGptConnected] = useState(false);
  const [chatGptLoading, setChatGptLoading] = useState(false);
  const [ollamaConnected, setOllamaConnected] = useState(false);
  const [ollamaLoading, setOllamaLoading] = useState(false);
  const [ollamaExpanded, setOllamaExpanded] = useState(false);
  const [ollamaUrl, setOllamaUrl] = useState("");
  const [ollamaApiKey, setOllamaApiKey] = useState("");
  const [ollamaError, setOllamaError] = useState("");

  // Read feedback query params and strip them to prevent re-display on refresh
  const linkedProvider = searchParams.get("linked");
  const error = searchParams.get("error");

  useEffect(() => {
    if (linkedProvider || error) {
      if (linkedProvider) {
        // Re-validate session so RainbowKit picks up the still-valid SIWE auth
        void updateSession();
      }
      // Strip query params after reading — prevents re-display on refresh/back
      router.replace("/profile");
    }
  }, [linkedProvider, error, router, updateSession]);

  // Fetch profile data + configured providers in parallel
  useEffect(() => {
    fetch("/api/v1/users/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: ProfileData | null) => {
        if (data) {
          setProfile(data);
          setSelectedColor(data.avatarColor ?? "#6366f1");
        }
      })
      .catch(() => {
        // Profile fetch failed — page still renders with session data
      });

    fetch("/api/v1/users/me/ownership")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: OwnershipSummary | null) => {
        if (data) setOwnership(data);
      })
      .catch(() => {
        // Ownership fetch failed — profile settings remain usable
      });

    fetch("/api/auth/providers")
      .then((res) => res.json())
      .then((providers: Record<string, { id: string }>) => {
        const ids = new Set(
          Object.keys(providers).filter((id) => id !== "credentials")
        );
        setConfiguredProviders(ids);
      })
      .catch(() => {
        // Provider fetch failed — show nothing rather than broken links
      });

    // Check BYO-AI ChatGPT connection status
    fetch("/api/v1/auth/openai-codex/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { connected: boolean } | null) => {
        if (data) setChatGptConnected(data.connected);
      })
      .catch(() => {});

    // Check OpenAI-compatible endpoint connection status
    fetch("/api/v1/auth/openai-compatible/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { connected: boolean } | null) => {
        if (data) setOllamaConnected(data.connected);
      })
      .catch(() => {});
  }, []);

  const walletAddress = session?.user?.walletAddress ?? null;
  const displayName =
    profile?.resolvedDisplayName ?? session?.user?.displayName ?? "User";
  const avatarLetter = displayName.charAt(0).toUpperCase();

  // Build set of linked provider IDs for quick lookup
  const linkedProviderIds = new Set(
    profile?.linkedProviders.map((p) => p.provider) ?? []
  );

  // Get provider login by provider ID
  const getProviderLogin = (providerId: string): string | null =>
    profile?.linkedProviders.find((p) => p.provider === providerId)
      ?.providerLogin ?? null;

  return (
    <PageContainer maxWidth="2xl">
      {/* Page heading */}
      <h1 className="font-semibold text-2xl text-foreground">Profile</h1>
      <div className="border-border border-b" />

      {/* Feedback banner for linking results */}
      <FeedbackBanner linkedProvider={linkedProvider} error={error} />

      {/* ── Profile section (display name + avatar color, no divider between) ── */}

      <div className="py-3">
        <div className="flex items-center justify-between gap-4 py-2">
          <div className="font-medium text-foreground text-sm">
            Display Name
          </div>
          <div className="flex items-center gap-3">
            <Avatar
              className="size-8"
              style={{ "--avatar-bg": selectedColor } as React.CSSProperties}
            >
              <AvatarFallback className="bg-[var(--avatar-bg)] font-semibold text-primary-foreground text-sm">
                {avatarLetter}
              </AvatarFallback>
            </Avatar>
            <span className="rounded-md border border-input bg-background px-3 py-1.5 text-foreground text-sm">
              {displayName}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 py-2">
          <div className="font-medium text-foreground text-sm">
            Avatar Color
          </div>
          <ColorPickerSwatch
            colors={AVATAR_COLORS}
            selected={selectedColor}
            onSelect={setSelectedColor}
          />
        </div>
      </div>
      <div className="border-border border-b" />

      {/* ── Wallet & Connected Accounts ── */}

      <SectionHeading>Wallet &amp; Connected Accounts</SectionHeading>

      <SettingRow
        icon={<EthereumIcon className="size-5" />}
        label="Ethereum"
        {...(walletAddress
          ? {}
          : { description: "Connect wallet to enable payments." })}
      >
        {walletAddress ? (
          <ConnectedBadge
            login={`${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`}
          />
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => openConnectModal?.()}
          >
            Connect
          </Button>
        )}
      </SettingRow>

      {OAUTH_PROVIDERS.filter(
        ({ id }) => configuredProviders.has(id) || linkedProviderIds.has(id)
      ).map(({ id, label, description, Icon }) => {
        const isLinked = linkedProviderIds.has(id);
        const login = getProviderLogin(id);

        return (
          <SettingRow
            key={id}
            icon={<Icon className="size-5" />}
            label={label}
            description={description}
          >
            {isLinked && login ? (
              <ConnectedBadge login={login} />
            ) : isLinked ? (
              <ConnectedBadge login="Connected" />
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const res = await fetch(`/api/auth/link/${id}`, {
                    method: "POST",
                  });
                  if (!res.ok) return;
                  signIn(id, {
                    callbackUrl: `/profile?linked=${id}`,
                  });
                }}
              >
                Link
              </Button>
            )}
          </SettingRow>
        );
      })}

      {/* ── AI Providers (BYO-AI) ── */}

      <SectionHeading>AI Providers</SectionHeading>

      <SettingRow
        icon={<OpenAIIcon className="size-5" />}
        label="ChatGPT"
        description={
          chatGptConnected
            ? "Your ChatGPT subscription is linked."
            : "Connect your ChatGPT subscription for $0 AI usage."
        }
      >
        {chatGptConnected ? (
          <div className="flex items-center gap-2">
            <ConnectedBadge login="Connected" />
            <Button
              variant="ghost"
              size="sm"
              disabled={chatGptLoading}
              onClick={async () => {
                setChatGptLoading(true);
                try {
                  const res = await fetch(
                    "/api/v1/auth/openai-codex/disconnect",
                    { method: "POST" }
                  );
                  if (res.ok) {
                    setChatGptConnected(false);
                  }
                } finally {
                  setChatGptLoading(false);
                }
              }}
            >
              Disconnect
            </Button>
          </div>
        ) : !chatGptLoading ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setChatGptLoading(true)}
          >
            Connect
          </Button>
        ) : null}
      </SettingRow>

      {/* Expanded connect flow — renders below the setting row */}
      {chatGptLoading && !chatGptConnected && (
        <ChatGptConnectFlow
          onComplete={() => {
            setChatGptConnected(true);
            setChatGptLoading(false);
          }}
          onCancel={() => setChatGptLoading(false)}
        />
      )}

      <SettingRow
        icon={<ServerIcon className="size-5" />}
        label="Local LLM"
        description={
          ollamaConnected
            ? "Your endpoint is connected."
            : "Connect Ollama, vLLM, or any OpenAI-compatible server."
        }
      >
        {ollamaConnected ? (
          <div className="flex items-center gap-2">
            <ConnectedBadge login="Connected" />
            <Button
              variant="ghost"
              size="sm"
              disabled={ollamaLoading}
              onClick={async () => {
                setOllamaLoading(true);
                try {
                  const res = await fetch(
                    "/api/v1/auth/openai-compatible/disconnect",
                    { method: "POST" }
                  );
                  if (res.ok) {
                    setOllamaConnected(false);
                  }
                } finally {
                  setOllamaLoading(false);
                }
              }}
            >
              Disconnect
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOllamaExpanded(!ollamaExpanded)}
          >
            Connect
          </Button>
        )}
      </SettingRow>

      {/* Expanded connect form */}
      {ollamaExpanded && !ollamaConnected && (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="space-y-2">
            <label
              htmlFor="ollama-url"
              className="font-medium text-foreground text-sm"
            >
              Endpoint URL
            </label>
            <input
              id="ollama-url"
              type="url"
              placeholder="http://localhost:11434"
              value={ollamaUrl}
              onChange={(e) => {
                setOllamaUrl(e.target.value);
                setOllamaError("");
              }}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-ring/50"
            />
            <p className="text-muted-foreground text-xs">
              Use a{" "}
              <a
                href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                Cloudflare Tunnel
              </a>{" "}
              for remote access.{" "}
              <a
                href="https://github.com/Cogni-DAO/cogni/blob/staging/docs/guides/connect-local-llm.md"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                Setup guide
              </a>
            </p>
          </div>
          <div className="space-y-2">
            <label
              htmlFor="ollama-key"
              className="font-medium text-foreground text-sm"
            >
              API Key
            </label>
            <input
              id="ollama-key"
              type="password"
              placeholder="sk-..."
              value={ollamaApiKey}
              onChange={(e) => {
                setOllamaApiKey(e.target.value);
                setOllamaError("");
              }}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-ring/50"
            />
          </div>
          {ollamaError && (
            <p className="text-destructive text-sm">{ollamaError}</p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={ollamaLoading || !ollamaUrl || !ollamaApiKey}
              onClick={async () => {
                setOllamaLoading(true);
                setOllamaError("");
                try {
                  const res = await fetch(
                    "/api/v1/auth/openai-compatible/connect",
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        endpointUrl: ollamaUrl,
                        apiKey: ollamaApiKey,
                      }),
                    }
                  );
                  const data = await res.json();
                  if (res.ok) {
                    setOllamaConnected(true);
                    setOllamaExpanded(false);
                    setOllamaUrl("");
                    setOllamaApiKey("");
                  } else {
                    setOllamaError(data.error ?? "Connection failed");
                  }
                } catch {
                  setOllamaError("Failed to connect");
                } finally {
                  setOllamaLoading(false);
                }
              }}
            >
              {ollamaLoading ? "Testing..." : "Test & Connect"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOllamaExpanded(false);
                setOllamaError("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* ── Ownership ── */}

      <SectionHeading>Ownership</SectionHeading>

      <div className="space-y-4 py-5">
        {/* Attribution summary */}
        <div>
          <h3 className="mb-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Attribution
          </h3>
          <div className="rounded-lg border border-border p-4">
            <div className="flex items-baseline justify-between gap-4">
              <div>
                <div className="font-semibold text-2xl text-foreground tabular-nums">
                  {ownership?.finalizedSharePercent?.toFixed(2) ?? "0.00"}%
                </div>
                <div className="mt-1 text-muted-foreground text-sm">
                  Ownership across {ownership?.epochsMatched ?? 0} epoch
                  {(ownership?.epochsMatched ?? 0) === 1 ? "" : "s"}
                </div>
              </div>
              <div className="text-right">
                <div className="font-medium text-foreground text-sm tabular-nums">
                  {formatUnits(ownership?.finalizedUnits ?? "0")} finalized
                </div>
                {Number(ownership?.pendingUnits ?? "0") > 0 && (
                  <div className="text-muted-foreground text-xs tabular-nums">
                    +{formatUnits(ownership?.pendingUnits ?? "0")} pending
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* On-chain distributions placeholder */}
        <div>
          <h3 className="mb-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">
            On-Chain Distributions
          </h3>
          <div className="rounded-lg border border-border p-6 text-center">
            <p className="text-muted-foreground text-sm">
              No on-chain distributions yet. Token distributions will appear
              here once enabled.
            </p>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
