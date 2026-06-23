# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

variable "environment" {
  description = "Environment name (candidate-a, preview, production). Stamped into the KMS alias + IAM principal name so each env gets a fully isolated unseal root."
  type        = string

  validation {
    condition     = contains(["candidate-a", "candidate-b", "preview", "production"], var.environment)
    error_message = "environment must be one of: candidate-a, candidate-b, preview, production."
  }
}
