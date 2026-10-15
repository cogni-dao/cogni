variable "apex_domain" {
  description = "Fleet apex used to derive candidate-a, preview, and production hosts."
  type        = string
  default     = "cognidao.org"
}

variable "public_probe_names" {
  description = "Independent Grafana public probes used for every node in every environment."
  type        = list(string)
  default     = ["Frankfurt", "Ohio"]

  validation {
    condition     = length(var.public_probe_names) >= 2
    error_message = "At least two independent public probes are required."
  }
}

variable "serve_build_shas" {
  description = "Approved deployed build SHAs keyed by catalog environment/node, verified against canonical deployment receipts. Missing slots fail closed; catalog source birth pins are not deployed identities."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([for slot, build_sha in var.serve_build_shas :
      can(regex("^(candidate-a|preview|production)/[a-z][a-z0-9-]*$", slot)) &&
      can(regex("^[0-9a-f]{40}$", build_sha))
    ])
    error_message = "Serve checks require catalog-slot keys and verified full lowercase deployed build SHAs."
  }
}

variable "recovery_receipts" {
  description = "Verified native incident receipts keyed by catalog environment/node, supplied after containment; no credentials."
  type = map(object({
    build_sha                  = string
    database_system_identifier = string
    incident_id                = string
  }))
  default = {}
  validation {
    condition = alltrue([for slot, receipt in var.recovery_receipts :
      can(regex("^(candidate-a|preview|production)/[a-z][a-z0-9-]*$", slot)) &&
      can(regex("^[0-9a-f]{40}$", receipt.build_sha)) &&
      can(regex("^[1-9][0-9]*$", receipt.database_system_identifier)) &&
      can(regex("^reliability\\.v1:[a-zA-Z0-9._:-]{1,180}$", receipt.incident_id))
    ])
    error_message = "Recovery checks require measured exact-SHA/native-database/current-incident receipts."
  }
}
