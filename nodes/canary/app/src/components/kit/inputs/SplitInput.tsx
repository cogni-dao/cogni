// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/inputs/SplitInput`
 * Purpose: Compound input with built-in label section (OpenRouter style).
 * Scope: Two-tone label|input row pattern. Does not handle validation or form submission.
 * Invariants: Label is left-aligned in black bg; input is right-aligned in slate-800 bg; height is fixed at h-16.
 * Side-effects: none
 * Notes: Mobile-first sizing; text input only (number inputs via type prop)
 * Links: /dummy Credits page pattern
 * @public
 */

import { cn } from "@cogni/node-ui-kit/util/cn";
import type { InputHTMLAttributes } from "react";

interface SplitInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

export function SplitInput({
  label,
  value,
  onChange,
  placeholder,
  className,
  ...props
}: SplitInputProps) {
  return (
    <div
      className={cn(
        "flex h-16 overflow-hidden rounded-lg border border-input",
        className
      )}
    >
      <div className="flex items-center bg-card px-6">
        <span className="font-semibold text-card-foreground">{label}</span>
      </div>
      <div className="relative flex flex-1 items-center bg-muted">
        <span className="absolute left-6 text-muted-foreground text-xl">$</span>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-transparent px-12 text-center text-foreground text-xl placeholder-muted-foreground focus:outline-none"
          {...props}
        />
      </div>
    </div>
  );
}
