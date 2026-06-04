// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/feedback/ErrorAlert`
 * Purpose: Generic error alert with retry and action buttons.
 * Scope: Presentational component with deduplication logic. Does not import contracts.
 * Invariants: Forwards ref; accepts aria-* and data-* unchanged; uses semantic tokens only.
 * Side-effects: none (except timer for auto-dismiss)
 * Notes: Feature layer maps domain errors to these generic props.
 * Links: docs/spec/ui-implementation.md
 * @public
 */

"use client";

import { cn } from "@cogni/node-ui-kit/util/cn";
import { AlertCircle, RefreshCw } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/kit/inputs/Button";
import { Alert, AlertDescription, AlertTitle } from "./Alert";

export interface ErrorAlertProps {
  /** Machine-readable error code */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Whether error is transient and can be retried */
  retryable?: boolean;
  /** Request ID for deduplication (optional) */
  requestId?: string;
  /** Show retry button */
  showRetry?: boolean;
  /** Show "Use Free Model" button */
  showSwitchFree?: boolean;
  /** Show "Add Credits" button */
  showAddCredits?: boolean;
  /** Callback when retry clicked */
  onRetry?: () => void;
  /** Callback when "Use Free Model" clicked */
  onSwitchFreeModel?: () => void;
  /** Callback when "Add Credits" clicked */
  onAddCredits?: () => void;
  /** Additional CSS classes for layout */
  className?: string;
}

export interface ErrorAlertRef {
  dismiss: () => void;
}

/**
 * Generic error alert with deduplication.
 *
 * Deduplication: same code within 5s AND same requestId = ignore.
 * Different requestId = new error, show it.
 * Auto-dismisses retryable errors after 10s.
 */
export const ErrorAlert = forwardRef<ErrorAlertRef, ErrorAlertProps>(
  (
    {
      code,
      message,
      retryable,
      requestId,
      showRetry,
      showSwitchFree,
      showAddCredits,
      onRetry,
      onSwitchFreeModel,
      onAddCredits,
      className,
    },
    ref
  ) => {
    const [visible, setVisible] = useState(false);
    const [displayCode, setDisplayCode] = useState("");
    const [displayMessage, setDisplayMessage] = useState("");

    const lastErrorKeyRef = useRef<string | null>(null);
    const lastRequestIdRef = useRef<string | undefined>(undefined);
    const lastErrorTimeRef = useRef<number>(0);
    const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useImperativeHandle(ref, () => ({
      dismiss: () => {
        setVisible(false);
        if (dismissTimerRef.current) {
          clearTimeout(dismissTimerRef.current);
          dismissTimerRef.current = null;
        }
      },
    }));

    useEffect(() => {
      if (!code || !message) {
        setVisible(false);
        return;
      }

      const errorKey = code;
      const now = Date.now();

      // Dedupe: same key within 5s AND same requestId = ignore
      if (
        lastErrorKeyRef.current === errorKey &&
        now - lastErrorTimeRef.current < 5000 &&
        lastRequestIdRef.current === requestId
      ) {
        return; // True duplicate
      }

      // New error or new request
      lastErrorKeyRef.current = errorKey;
      lastRequestIdRef.current = requestId;
      lastErrorTimeRef.current = now;
      setDisplayCode(code);
      setDisplayMessage(message);
      setVisible(true);

      // Clear previous timer
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
      }

      // Auto-dismiss retryable errors after 10s
      if (retryable) {
        dismissTimerRef.current = setTimeout(() => {
          setVisible(false);
        }, 10000);
      }

      return () => {
        if (dismissTimerRef.current) {
          clearTimeout(dismissTimerRef.current);
        }
      };
    }, [code, message, requestId, retryable]);

    if (!visible) return null;

    const hasActions = showRetry || showSwitchFree || showAddCredits;

    return (
      <Alert
        variant="destructive"
        className={cn("fade-in animate-in", className)}
      >
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>{displayCode.replace(/_/g, " ")}</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <span>{displayMessage}</span>
          {hasActions && (
            <div className="flex gap-2">
              {showRetry && onRetry && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRetry}
                  className="gap-1"
                >
                  <RefreshCw className="h-3 w-3" />
                  Retry
                </Button>
              )}
              {showSwitchFree && onSwitchFreeModel && (
                <Button variant="outline" size="sm" onClick={onSwitchFreeModel}>
                  Use Free Model
                </Button>
              )}
              {showAddCredits && onAddCredits && (
                <Button variant="outline" size="sm" onClick={onAddCredits}>
                  Add Credits
                </Button>
              )}
            </div>
          )}
        </AlertDescription>
      </Alert>
    );
  }
);
ErrorAlert.displayName = "ErrorAlert";
