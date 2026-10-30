// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

export function canonicalProofJson(value: unknown): string {
 if(value === null || typeof value !== "object") return JSON.stringify(value);
 if(Array.isArray(value)) return `[${value.map(canonicalProofJson).join(",")}]`;
 return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonicalProofJson((value as Record<string,unknown>)[k])}`).join(",")}}`;
}
