terraform {
  required_version = ">= 1.8.0"

  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 4.45"
    }
  }
}

# Authentication is injected with GRAFANA_SM_ACCESS_TOKEN and GRAFANA_SM_URL.
# No credential is accepted as an input or written into this configuration.
provider "grafana" {}

data "grafana_synthetic_monitoring_probes" "public" {}

locals {
  catalog = [
    for catalog_file in fileset("${path.module}/../../catalog", "*.yaml") :
    yamldecode(file("${path.module}/../../catalog/${catalog_file}"))
  ]

  production_nodes = {
    for entry in local.catalog : entry.name => entry
    if entry.type == "node" && contains(try(entry.envs, []), "production")
  }

  production_hosts = {
    for slug, entry in local.production_nodes :
    slug => try(entry.is_primary_host, false) ? var.apex_domain : "${slug}.${var.apex_domain}"
  }

  public_probe_ids = [
    for probe_name in var.public_probe_names :
    data.grafana_synthetic_monitoring_probes.public.probes[probe_name]
  ]
}

resource "grafana_synthetic_monitoring_check" "production_readyz" {
  for_each = local.production_hosts

  job                = "cogni-production-${each.key}-readyz"
  target             = "https://${each.value}/readyz"
  enabled            = true
  probes             = local.public_probe_ids
  frequency          = 60000
  timeout            = 5000
  alert_sensitivity  = "high"
  basic_metrics_only = true
  folder_uid         = var.folder_uid == "" ? null : var.folder_uid

  labels = {
    environment = "production"
    node_slug   = each.key
    proof_class = "serve"
    managed_by  = "opentofu"
  }

  settings {
    http {
      method              = "GET"
      ip_version          = "V4"
      fail_if_not_ssl     = true
      no_follow_redirects = true
      valid_status_codes  = [200]
      fail_if_body_not_matches_regexp = [
        "\\\"status\\\"[[:space:]]*:[[:space:]]*\\\"healthy\\\"",
      ]
    }
  }
}

output "production_checks" {
  description = "Synthetic Monitoring check IDs keyed by production node slug."
  value = {
    for slug, check in grafana_synthetic_monitoring_check.production_readyz :
    slug => check.id
  }
}
