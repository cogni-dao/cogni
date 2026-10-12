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
