# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Per-env AWS KMS auto-unseal root-of-trust for OpenBao (bug.5011 / bug.5051,
# access-control-charter.md CC6.1 🔴 "Cloud KMS auto-unseal").
#
# WHAT THIS PROVISIONS — exactly two resources per env, nothing more:
#   1. ONE symmetric KMS key (the unseal root). OpenBao wraps its master key
#      with this; on every pod start OpenBao calls kms:Decrypt to unwrap it and
#      unseals itself with zero human input. A sealed-on-restart vault (the
#      bug.5011/5051 outage class) becomes impossible.
#   2. ONE least-privilege IAM principal whose ONLY power is Encrypt / Decrypt /
#      DescribeKey on THIS key. It cannot read any secret, list keys, or touch
#      any other AWS resource. Stealing its credential lets an attacker unwrap a
#      master key they don't have — i.e. nothing.
#
# WHY KMS AND NOT AN OSS-NATIVE SEAL (transit / SoftHSM) — see PR body + the
# provider-comparison table. Short version: the root-of-trust MUST live OFF the
# k3s node, or a node restart/OOM reseals it again (the exact bug). `seal
# "transit"` only relocates the manual-unseal SPOF to a second OpenBao that
# itself must be unsealed (turtles), and doubles the Raft/PVC operational
# surface on an already-OOMing 6 GB box. `seal "pkcs11"` + SoftHSM puts the
# token DB + PIN on the same node — the key-next-to-lock pattern bug.5011
# explicitly REJECTED (fails SOC2 CC6.1). The seal MECHANISM stays 100%
# OpenBao-native (the OSS `seal` stanza); only the root-of-trust is managed.
# This IS the charter's named CC6.1 control, not a bespoke hack.
#
# CHICKEN-AND-EGG (Invariant 4 — NO secret value in git): the IAM credential
# this module mints is the ONE secret that cannot live in OpenBao, because it is
# what unseals OpenBao. It (plus the non-secret key id) is delivered to the pod
# as plain env (VAULT_AWSKMS_SEAL_KEY_ID / AWS_ACCESS_KEY_ID /
# AWS_SECRET_ACCESS_KEY / AWS_REGION) via the openbao chart
# `server.extraSecretEnvironmentVars` → the `openbao-seal-aws` k8s Secret seeded
# once at provision time (provision-env-vm.sh Phase 5b, beside the init artifacts
# in .local/). It is the seal-backend bootstrap credential, the analogue of the
# Shamir keys it replaces — held by the provisioner, never committed.
#
# STATE: OpenTofu, applied out-of-band by an operator with an AWS account (the
# ONE human gate). Not wired into provision-env.yml — the deploy brain is frozen
# (cicd-platform-boundary.md); adding a cloud-credential-minting job to a deploy
# workflow is exactly the platform logic the freeze forbids. Run it once per env
# from a laptop/CI with AWS admin, capture the two outputs into .local/, feed
# them to the openbao Secret. See infra/provision/aws-kms/README.md.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # Remote backend intentionally omitted to match the Cherry modules' current
  # local-state convention; wire an S3 backend when the rest of infra/provision
  # gets one (the commented stanza in cherry/base/main.tf is the template).
}

# Region comes from the standard AWS provider chain (AWS_REGION env /
# ~/.aws/config / -var). The provider block is intentionally empty so this
# module carries no embedded account/region — the operator supplies them.
provider "aws" {}

locals {
  # One key + one principal per env. The alias and IAM name are env-stamped so
  # candidate-a / preview / production each get a fully isolated unseal root —
  # a compromised preview unseal credential can never decrypt prod's master key.
  name = "cogni-${var.environment}-openbao-unseal"
}

# ── The unseal root key ────────────────────────────────────────────────────
resource "aws_kms_key" "openbao_unseal" {
  description              = "OpenBao auto-unseal master-key wrapper for env=${var.environment} (bug.5011)"
  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  # Rotation is free + invisible to OpenBao (it always asks KMS to decrypt;
  # KMS picks the right key version). Turn it on — SOC2 CC6.1 likes it.
  enable_key_rotation = true
  # 30-day window: a fat-fingered destroy is recoverable, but a real
  # decommission still completes. Never 7 (too tight for a root-of-trust).
  deletion_window_in_days = 30

  tags = {
    "cogni:env"       = var.environment
    "cogni:purpose"   = "openbao-auto-unseal"
    "cogni:managedby" = "opentofu"
  }
}

resource "aws_kms_alias" "openbao_unseal" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.openbao_unseal.key_id
}

# ── The least-privilege seal principal ─────────────────────────────────────
# A dedicated IAM user (not the operator's own creds) so the credential that
# ships to the pod has the smallest possible blast radius. OpenBao on Cherry
# bare-metal is outside AWS, so an IAM-role/IRSA path isn't available — a
# long-lived access key is the standard pattern for off-AWS Vault auto-unseal.
resource "aws_iam_user" "openbao_unseal" {
  name = local.name
  tags = {
    "cogni:env"       = var.environment
    "cogni:purpose"   = "openbao-auto-unseal"
    "cogni:managedby" = "opentofu"
  }
}

# Scoped to THIS key only. No kms:ListKeys, no wildcard resource, no other
# action. This is the entire authority the seal credential carries.
data "aws_iam_policy_document" "openbao_unseal" {
  statement {
    sid    = "OpenBaoSealUnwrap"
    effect = "Allow"
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:DescribeKey",
    ]
    resources = [aws_kms_key.openbao_unseal.arn]
  }
}

resource "aws_iam_user_policy" "openbao_unseal" {
  name   = "${local.name}-seal"
  user   = aws_iam_user.openbao_unseal.name
  policy = data.aws_iam_policy_document.openbao_unseal.json
}

resource "aws_iam_access_key" "openbao_unseal" {
  user = aws_iam_user.openbao_unseal.name
}
