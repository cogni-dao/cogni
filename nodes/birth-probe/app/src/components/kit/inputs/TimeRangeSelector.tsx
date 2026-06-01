// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/inputs/TimeRangeSelector`
 * Purpose: Time range selector dropdown for filtering time-series data.
 * Scope: Reusable time range picker. Wraps shadcn Select. Does not fetch data or persist filter state.
 * Invariants: Uses shadcn Select component.
 * Side-effects: none
 * Links: [ActivityView](../../../app/(app)/activity/view.tsx)
 * @public
 */

"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@cogni/node-ui-kit/shadcn/select";

export type TimeRange = "1d" | "1w" | "1m";

export interface TimeRangeSelectorProps {
  value: TimeRange;
  onValueChange: (value: TimeRange) => void;
  className?: string;
}

const timeRangeLabels: Record<TimeRange, string> = {
  "1d": "Last Day",
  "1w": "Last Week",
  "1m": "Last Month",
};

export function TimeRangeSelector({
  value,
  onValueChange,
  className,
}: TimeRangeSelectorProps) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className={className} aria-label="Select time range">
        <SelectValue placeholder={timeRangeLabels[value]} />
      </SelectTrigger>
      <SelectContent className="rounded-xl">
        <SelectItem value="1d" className="rounded-lg">
          Last Day
        </SelectItem>
        <SelectItem value="1w" className="rounded-lg">
          Last Week
        </SelectItem>
        <SelectItem value="1m" className="rounded-lg">
          Last Month
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
