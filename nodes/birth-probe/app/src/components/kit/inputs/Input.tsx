// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/inputs/Input`
 * Purpose: Input component wrapper using CVA styling for text-based inputs.
 * Scope: Provides Input component with variant props. Does not handle form submission or validation.
 * Invariants: Forwards ref; accepts standard input props.
 * Side-effects: none
 * Notes: Uses CVA for styling - no literal classes allowed.
 * Links: docs/spec/ui-implementation.md
 * @public
 */

import { cn } from "@cogni/node-ui-kit/util/cn";
import { forwardRef, type InputHTMLAttributes } from "react";
import { input } from "@/styles/ui";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => {
    return <input className={cn(input(), className)} ref={ref} {...props} />;
  }
);

Input.displayName = "Input";

export { Input };
