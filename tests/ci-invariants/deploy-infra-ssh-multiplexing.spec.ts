// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/deploy-infra-ssh-multiplexing`
 * Purpose: Pin the bug.5159 invariant that `scripts/ci/deploy-infra.sh` rides every ssh/scp/rsync leg over ONE ControlMaster transport on a per-run socket, so the deploy's handshake burst cannot trip sshd's MaxStartups admission control.
 * Scope: Static read of the deploy script's text; does not execute the script, open SSH, or reach any VM.
 * Invariants:
 *   - SSH_MULTIPLEXED: SSH_OPTS carries ControlMaster/ControlPath/ControlPersist.
 *   - CONTROL_PATH_PER_RUN: the socket lives under a `mktemp -d` dir and names the env + host, never a fixed /tmp path.
 *   - HOST_KEY_CHECKING_UNWEAKENED: StrictHostKeyChecking stays `yes`.
 * Side-effects: IO (reads one file from the repo)
 * Links: bug.5159, scripts/ci/deploy-infra.sh, scripts/ci/lib/ssh-retry.sh
 * @public
 *
 * WHY THIS EXISTS. Measured 2026-10-09: two production infra deploys (runs 37868061021,
 * 37868723855 — the second with no concurrent deploy) died on an early `scp` with
 * `kex_exchange_identification: read: Connection reset by peer` / `scp: Connection closed`
 * / exit 255, while the production app itself served 200s. The script opens twelve separate
 * SSH handshakes to one VM back to back and `on_fail` opens seven more; sshd sheds new
 * connections mid-banner-exchange once that burst forms. `reconcile-node-substrate.sh` and
 * `secret-materialize.sh` were already converted to one master connection for this same bug —
 * deploy-infra was the last SSH-heavy CI path left unconverted, so the regression is easy to
 * reintroduce by editing the SSH_OPTS line. This test makes that edit fail the gate.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = readFileSync(
  path.join(REPO_ROOT, "scripts/ci/deploy-infra.sh"),
  "utf8"
);

/** The single line that appends the multiplexing options onto SSH_OPTS. */
const MUX_APPEND = SCRIPT.split("\n").find(
  (line) =>
    line.startsWith("SSH_OPTS=") && line.includes("ControlMaster") === true
);

describe("deploy-infra.sh SSH multiplexing (bug.5159)", () => {
  it("multiplexes every leg over one ControlMaster transport", () => {
    expect(MUX_APPEND).toBeDefined();
    expect(MUX_APPEND).toContain("-o ControlMaster=auto");
    expect(MUX_APPEND).toContain("-o ControlPath=");
    expect(MUX_APPEND).toMatch(/-o ControlPersist=\d+/);
  });

  it("extends the existing SSH_OPTS rather than replacing it", () => {
    // A bare reassignment would silently drop the key path and the keepalives.
    expect(MUX_APPEND).toMatch(/^SSH_OPTS="\$SSH_OPTS /);
  });

  it("puts the control socket on a per-run mktemp path, not a fixed /tmp name", () => {
    // Two deploys for DIFFERENT environments can run concurrently (a candidate-a
    // infra flight during a production promote). A fixed path would have them
    // share one master and address the wrong VM.
    expect(SCRIPT).toMatch(/SSH_MUX_DIR="\$\(mktemp -d /);
    expect(SCRIPT).toContain(
      'SSH_MUX_CONTROL_PATH="$SSH_MUX_DIR/${ENVIRONMENT}-%h"'
    );
    expect(SCRIPT).not.toMatch(/ControlPath=\/tmp\//);
  });

  it("tears the master down on exit", () => {
    expect(SCRIPT).toContain("cleanup_ssh_mux()");
    expect(SCRIPT).toContain("trap 'cleanup_worktree; cleanup_ssh_mux' EXIT");
  });

  it("does not weaken host-key checking", () => {
    expect(SCRIPT).not.toContain("StrictHostKeyChecking=no");
    expect(SCRIPT).not.toContain("StrictHostKeyChecking=accept-new");
    const strictOpts = SCRIPT.match(/StrictHostKeyChecking=\S+/g) ?? [];
    expect(strictOpts.length).toBeGreaterThan(0);
    for (const opt of strictOpts) {
      expect(opt).toBe("StrictHostKeyChecking=yes");
    }
  });
});
