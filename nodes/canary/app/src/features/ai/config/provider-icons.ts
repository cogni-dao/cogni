// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/config/provider-icons`
 * Purpose: Provider icon registry for model selection UI.
 * Scope: Maps provider keys and model ID prefixes to icon components (custom SVGs + Lucide fallbacks).
 * Invariants: Icons use currentColor for theme compatibility. MODEL_PREFIX_TO_PROVIDER maps model ID prefixes (gpt, claude, gemini) to provider icon keys.
 * Side-effects: none
 * Links: Used by ModelPicker component
 * @internal
 */

import { Zap } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

import { AnthropicIcon } from "../icons/providers/AnthropicIcon";
import { DeepSeekIcon } from "../icons/providers/DeepSeekIcon";
import { GeminiIcon } from "../icons/providers/GeminiIcon";
import { KimiIcon } from "../icons/providers/KimiIcon";
import { LlamaIcon } from "../icons/providers/LlamaIcon";
import { MinimaxIcon } from "../icons/providers/MinimaxIcon";
import { MistralIcon } from "../icons/providers/MistralIcon";
import { NovaIcon } from "../icons/providers/NovaIcon";
import { NvidiaIcon } from "../icons/providers/NvidiaIcon";
import { OpenAIIcon } from "../icons/providers/OpenAIIcon";
import { QwenIcon } from "../icons/providers/QwenIcon";
import { XAIIcon } from "../icons/providers/XAIIcon";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * Provider-to-icon mapping
 * Keys match provider_key from LiteLLM model_info
 */
const PROVIDER_ICONS = {
  amazon: NovaIcon,
  anthropic: AnthropicIcon,
  deepseek: DeepSeekIcon,
  google: GeminiIcon,
  kimi: KimiIcon,
  minimax: MinimaxIcon,
  mistral: MistralIcon,
  nvidia: NvidiaIcon,
  llama: LlamaIcon,
  openai: OpenAIIcon,
  qwen: QwenIcon,
  xai: XAIIcon,
  default: Zap,
} as const satisfies Record<string, IconComponent>;

/**
 * Map common model ID prefixes to their provider icon key.
 * Covers cases where providerKey is unavailable (e.g. "platform" provider).
 */
const MODEL_PREFIX_TO_PROVIDER: Record<string, keyof typeof PROVIDER_ICONS> = {
  gpt: "openai",
  o1: "openai",
  o3: "openai",
  o4: "openai",
  chatgpt: "openai",
  claude: "anthropic",
  gemini: "google",
};

/**
 * Extract provider key from model ID
 * Examples:
 * - "qwen3-4b" → "qwen"
 * - "gpt-4o-mini" → "openai"
 * - "claude-3-haiku" → "anthropic"
 */
function getProviderKey(modelId: string): keyof typeof PROVIDER_ICONS {
  const match = modelId.match(/^([a-z0-9]+)/i);
  if (!match?.[1]) return "default";

  const key = match[1].toLowerCase();
  if (key in PROVIDER_ICONS) return key as keyof typeof PROVIDER_ICONS;
  const mappedProvider = MODEL_PREFIX_TO_PROVIDER[key];
  if (mappedProvider) return mappedProvider;
  return "default";
}

/**
 * Get icon component for a model ID
 * Falls back to default icon if provider not found
 */
export function getProviderIcon(modelId: string): IconComponent {
  const providerKey = getProviderKey(modelId);
  return PROVIDER_ICONS[providerKey];
}

/**
 * Get icon component directly from provider key
 * Use when providerKey is available from model_info
 */
export function getIconByProviderKey(
  providerKey: string | undefined
): IconComponent {
  if (!providerKey) return PROVIDER_ICONS.default;
  return providerKey in PROVIDER_ICONS
    ? PROVIDER_ICONS[providerKey as keyof typeof PROVIDER_ICONS]
    : PROVIDER_ICONS.default;
}

/**
 * Resolve icon for a model — tries providerKey first, falls back to model ID prefix.
 * Handles "platform" providerKey (no direct icon) by extracting from model ID.
 */
export function resolveModelIcon(
  providerKey: string | undefined,
  modelId: string
): IconComponent {
  if (providerKey && providerKey in PROVIDER_ICONS) {
    return PROVIDER_ICONS[providerKey as keyof typeof PROVIDER_ICONS];
  }
  return getProviderIcon(modelId);
}
