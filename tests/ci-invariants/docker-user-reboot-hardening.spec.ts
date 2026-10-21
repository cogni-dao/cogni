// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/docker-user-reboot-hardening`
 * Purpose: Pin that DOCKER-USER public-port hardening is re-applied after every reboot on new and existing VMs.
 * Scope: Static reads of the hardener, bootstrap, OpenTofu, deploy-infra and egress action. Does not access a VM or systemd.
 * Invariants:
 *   - BOOT_REPLAY_UNIT_IS_DOCKER_BOUND: the hardener installs a oneshot unit that requires, follows and is
 *     wanted by docker.service (and multi-user.target), and re-runs the installed hardener copy.
 *   - BOOT_REPLAY_USES_INSTALLED_INPUTS: the unit uses PrivateTmp so it replays only the installed allowlist,
 *     never a staged render, and the hardener only enables (never starts) its own unit.
 *   - EVERY_INSTALL_PATH_RUNS_THE_HARDENER: cloud-init bootstrap (new VMs), deploy-infra (existing VMs) and
 *     the compute-egress reconcile all ship and run this one hardener, so each one installs the unit.
 * Side-effects: IO (reads committed files)
 * Notes: Behavioral proof (install, idempotency, boot replay) lives in scripts/ci/tests/render-compute-egress-allowlist.test.sh.
 * Links: story.5084, bug.5167, infra/provision/cherry/harden-docker-public-ports.sh
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const read = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

const HARDENER_PATH = "infra/provision/cherry/harden-docker-public-ports.sh";
const UNIT_NAME = "cogni-harden-docker-public-ports.service";
const INSTALLED_HARDENER =
  "/usr/local/sbin/cogni-harden-docker-public-ports.sh";

const hardener = read(HARDENER_PATH);
const bootstrap = read("infra/provision/cherry/base/bootstrap.yaml");
const provision = read("infra/provision/cherry/base/main.tf");
const deployInfra = read("scripts/ci/deploy-infra.sh");
const egressAction = read(
  ".github/actions/reconcile-compute-egress/action.yml"
);

function unitBody(): string {
  const match = hardener.match(/<<UNIT_EOF\n([\s\S]*?)\nUNIT_EOF\n/);
  expect(match, "hardener must embed its boot replay unit").toBeTruthy();
  return match?.[1] ?? "";
}

describe("DOCKER-USER hardening survives reboot (story.5084)", () => {
  it("installs a docker-bound oneshot unit that replays the installed hardener", () => {
    const unit = unitBody().split("\n");
    for (const directive of [
      "Requires=docker.service",
      "After=docker.service network-online.target",
      "PartOf=docker.service",
      "Type=oneshot",
      "RemainAfterExit=yes",
      "PrivateTmp=yes",
      "ExecStart=/bin/bash $BOOT_SCRIPT",
      "WantedBy=multi-user.target docker.service",
    ]) {
      expect(unit).toContain(directive);
    }
    expect(hardener).toContain(`BOOT_UNIT_NAME="${UNIT_NAME}"`);
    expect(hardener).toContain(
      `BOOT_SCRIPT="\${HARDEN_BOOT_SCRIPT:-${INSTALLED_HARDENER}}"`
    );
    expect(hardener).toContain(
      'BOOT_UNIT="${HARDEN_BOOT_UNIT:-/etc/systemd/system/$BOOT_UNIT_NAME}"'
    );
  });

  it("enables the unit after the rules are persisted and never starts it inline", () => {
    const save = hardener.indexOf("netfilter-persistent save");
    const enable = hardener.indexOf(
      'systemctl reenable --quiet "$BOOT_UNIT_NAME"'
    );
    expect(save).toBeGreaterThan(0);
    expect(enable).toBeGreaterThan(save);
    expect(hardener).toContain(
      'systemctl is-enabled --quiet "$BOOT_UNIT_NAME" || systemctl enable --quiet "$BOOT_UNIT_NAME"'
    );
    expect(hardener).not.toMatch(/systemctl\s+(?:start|restart)\b/);
    expect(hardener).not.toContain("--now");
  });

  it("installs the unit on new VMs through cloud-init bootstrap", () => {
    expect(provision).toContain(
      'harden_script        = file("${path.module}/../harden-docker-public-ports.sh")'
    );
    expect(bootstrap).toContain(`- path: ${INSTALLED_HARDENER}`);
    expect(bootstrap).toContain("${indent(6, harden_script)}");
    const dockerUp = bootstrap.indexOf("systemctl start docker");
    const harden = bootstrap.indexOf(`bash ${INSTALLED_HARDENER}`);
    expect(dockerUp).toBeGreaterThan(0);
    expect(harden).toBeGreaterThan(dockerUp);
  });

  it("installs the unit on existing VMs through deploy-infra", () => {
    expect(deployInfra).toContain(
      `"$REPO_ROOT/${HARDENER_PATH}" \\\n  "root@\${VM_HOST}:\${REMOTE_HARDEN_SCRIPT}"`
    );
    expect(deployInfra).toContain(
      'STAGED_ALLOWLIST="$REMOTE_COMPUTE_EGRESS_ALLOWLIST" bash "$REMOTE_HARDEN_SCRIPT"'
    );
    expect(deployInfra).toMatch(
      /REMOTE_ENV_VARS=\([\s\S]*\bREMOTE_HARDEN_SCRIPT\b[\s\S]*\)/
    );
  });

  it("refreshes the unit on compute-egress reconciles", () => {
    expect(egressAction).toContain(
      '"${APP_SOURCE_ROOT}/infra/provision/cherry/harden-docker-public-ports.sh"'
    );
    expect(egressAction).toContain("bash '${remote_hardener}'");
  });
});
