variable "apex_domain" {
  description = "Production domain used by the catalog host convention."
  type        = string
  default     = "cognidao.org"
}

variable "public_probe_names" {
  description = "Independent Grafana public probes used for every production node."
  type        = list(string)
  default     = ["Frankfurt", "Ohio"]

  validation {
    condition     = length(var.public_probe_names) >= 2
    error_message = "At least two independent public probes are required."
  }
}
