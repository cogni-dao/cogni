# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

output "kms_key_id" {
  description = "KMS key ID for the openbao `seal \"awskms\"` stanza (kms_key_id field). Non-sensitive — it's an identifier, not a secret."
  value       = aws_kms_key.openbao_unseal.key_id
}

output "kms_key_arn" {
  description = "Full ARN of the unseal key (for reference / IAM auditing)."
  value       = aws_kms_key.openbao_unseal.arn
}

output "kms_region" {
  description = "Region the key lives in — feed to the pod as AWS_REGION."
  value       = data.aws_region.current.name
}

output "seal_access_key_id" {
  description = "AWS_ACCESS_KEY_ID for the scoped seal principal. Seed into the openbao k8s Secret (provision-env-vm.sh Phase 5b). NOT a secret value committed to git — captured into .local/ by the operator."
  value       = aws_iam_access_key.openbao_unseal.id
  sensitive   = true
}

output "seal_secret_access_key" {
  description = "AWS_SECRET_ACCESS_KEY for the scoped seal principal. The ONE credential that cannot live in OpenBao (it unseals OpenBao). Held by the provisioner; seeded into the openbao Secret."
  value       = aws_iam_access_key.openbao_unseal.secret
  sensitive   = true
}

data "aws_region" "current" {}
