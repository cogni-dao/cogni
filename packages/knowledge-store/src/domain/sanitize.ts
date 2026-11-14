// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/sanitize`
 * Purpose: Normalise free-text knowledge fields at the write boundary so stored content can never carry raw control bytes.
 * Scope: Pure string helpers. Does not perform I/O or depend on any framework.
 * Invariants:
 *   - PRESERVE_MARKDOWN_WHITESPACE: TAB (U+0009), LF (U+000A), and CR (U+000D)
 *     are the only control characters legitimate in markdown prose; they survive.
 *     Every other C0 control (U+0000–U+0008, U+000B, U+000C, U+000E–U+001F) and
 *     DEL (U+007F) is stripped.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/knowledge-data-plane, bug.5062
 * @public
 */

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const DEL = 0x7f;
const C0_UPPER = 0x1f; // last C0 control code point

/**
 * A code point that must not be stored: any C0 control except the markdown
 * whitespace TAB/LF/CR, plus DEL.
 */
function isDangerousControlCode(code: number): boolean {
  if (code === DEL) return true;
  return code <= C0_UPPER && code !== TAB && code !== LF && code !== CR;
}

/**
 * Remove control characters that have no place in stored knowledge text.
 *
 * Raw C0 controls and DEL break naive downstream consumers that do not run the
 * bytes back through a spec-compliant JSON serialiser — the failure class
 * behind bug.5062, where an agent's `jq` over the knowledge recall list choked
 * on unescaped control characters and the domain read as empty. The knowledge
 * API itself re-escapes on read via `NextResponse.json`, so this is
 * defence-in-depth: it stops bad content at the write boundary (checklist item
 * 5) so no consumer — proxy, exporter, log line, future NDJSON stream — can
 * ever see it.
 *
 * Preserves TAB/LF/CR (PRESERVE_MARKDOWN_WHITESPACE) so markdown prose and
 * `html` entries round-trip unchanged.
 */
export function stripDangerousControlChars(input: string): string {
  // Fast path: most content has no control chars beyond the whitelist, so scan
  // once and only allocate a new string when a strip is actually required.
  let needsStrip = false;
  for (let i = 0; i < input.length; i++) {
    if (isDangerousControlCode(input.charCodeAt(i))) {
      needsStrip = true;
      break;
    }
  }
  if (!needsStrip) return input;

  let out = "";
  for (let i = 0; i < input.length; i++) {
    if (isDangerousControlCode(input.charCodeAt(i))) continue;
    out += input[i];
  }
  return out;
}
