// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Display-only exact formatting for provider-native compute amounts. */

interface NativeAmount {
  readonly amount: string;
  readonly denom: string;
}

function addDecimal(left: string, right: string): string {
  const [leftWhole = "0", leftFraction = ""] = left.split(".");
  const [rightWhole = "0", rightFraction = ""] = right.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftValue = BigInt(`${leftWhole}${leftFraction.padEnd(scale, "0")}`);
  const rightValue = BigInt(`${rightWhole}${rightFraction.padEnd(scale, "0")}`);
  const padded = (leftValue + rightValue).toString().padStart(scale + 1, "0");
  if (scale === 0) return padded;
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function sumComputeAmounts(
  groups: readonly (readonly NativeAmount[])[]
): NativeAmount[] {
  const totals = new Map<string, string>();
  for (const values of groups) {
    for (const value of values) {
      totals.set(
        value.denom,
        addDecimal(totals.get(value.denom) ?? "0", value.amount)
      );
    }
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([denom, amount]) => ({ denom, amount }));
}

function formatMicroUnits(amount: string, symbol: string): string {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(amount);
  if (!match) return `${amount} ${symbol}`;
  const inputFraction = match[2] ?? "";
  const scale = inputFraction.length + 6;
  const coefficient = `${match[1]}${inputFraction}`.replace(/^0+(?=\d)/, "");
  const padded = coefficient.padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  const value = fraction ? `${whole}.${fraction}` : whole;
  return symbol === "$" ? `$${value}` : `${value} ${symbol}`;
}

export function formatComputeAmount(value: NativeAmount): string {
  if (value.denom === "uact" || value.denom === "uusdc") {
    return formatMicroUnits(value.amount, "$");
  }
  if (value.denom === "uakt") {
    return formatMicroUnits(value.amount, "AKT");
  }
  return `${value.amount} ${value.denom}`;
}

function formatUsdDisplay(amount: string): string {
  const exact = formatMicroUnits(amount, "$");
  if (!exact.startsWith("$")) return exact;
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(exact.slice(1));
  if (!match) return exact;
  const whole = BigInt(match[1] ?? "0");
  const fraction = match[2] ?? "";
  if (
    whole === 0n &&
    /[1-9]/.test(fraction) &&
    fraction.padEnd(2, "0").slice(0, 2) === "00"
  ) {
    return "<$0.01";
  }
  const padded = fraction.padEnd(3, "0");
  let cents = whole * 100n + BigInt(padded.slice(0, 2));
  if (padded.charCodeAt(2) >= 53) cents += 1n;
  const dollars = cents / 100n;
  const remainder = (cents % 100n)
    .toString()
    .padStart(2, "0")
    .replace(/0$/, "");
  return remainder ? `$${dollars}.${remainder}` : `$${dollars}`;
}

/** Human-scale dashboard formatting; exact provider-native strings remain in the read model. */
export function formatComputeAmountDisplay(value: NativeAmount): string {
  if (value.denom === "uact" || value.denom === "uusdc") {
    return formatUsdDisplay(value.amount);
  }
  return formatComputeAmount(value);
}

export function formatComputeAmounts(values: readonly NativeAmount[]): string {
  if (values.length === 0) return "$0";
  return values.map(formatComputeAmount).join(" + ");
}

export function formatComputeAmountsDisplay(
  values: readonly NativeAmount[]
): string {
  if (values.length === 0) return "$0";
  return values.map(formatComputeAmountDisplay).join(" + ");
}
