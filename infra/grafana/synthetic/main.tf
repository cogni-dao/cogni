terraform {
  required_version = ">= 1.8.0"

  # The fleet monitor must not depend on one laptop's local state. Credentials
  # are supplied only through PG_CONN_STR; no backend secret belongs in git or
  # a saved plan. The checks keep running in Grafana if this database is down.
  backend "pg" {
    schema_name = "grafana_fleet_state"
  }

  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 4.45"
    }
  }
}

# Both clients come from the supported Grafana provider. Authentication is
# injected at runtime: GRAFANA_URL + GRAFANA_AUTH for the stack API and
# GRAFANA_SM_URL + GRAFANA_SM_ACCESS_TOKEN for Synthetic Monitoring.
provider "grafana" {
  alias = "stack"
}

provider "grafana" {
  alias = "sm"
}

data "grafana_synthetic_monitoring_probes" "public" {
  provider = grafana.sm
}

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

  # The provisioning export remains human-reviewable YAML. OpenTofu is its
  # single apply owner, so alerts cannot silently diverge from this file.
  fleet_alert_group = yamldecode(
    file("${path.module}/../alerts/fleet-capacity.alerts.yaml")
  ).groups[0]
}

resource "grafana_folder" "reliability" {
  provider = grafana.stack
  title    = "Cogni Reliability"
}

resource "grafana_synthetic_monitoring_check" "production_readyz" {
  provider = grafana.sm
  for_each = local.production_hosts

  job                = "cogni-production-${each.key}-readyz"
  target             = "https://${each.value}/readyz"
  enabled            = true
  probes             = local.public_probe_ids
  frequency          = 60000
  timeout            = 5000
  alert_sensitivity  = "high"
  basic_metrics_only = true
  folder_uid         = grafana_folder.reliability.uid

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

resource "grafana_rule_group" "fleet_capacity" {
  provider         = grafana.stack
  name             = local.fleet_alert_group.name
  folder_uid       = grafana_folder.reliability.uid
  interval_seconds = 60
  org_id           = local.fleet_alert_group.orgId

  dynamic "rule" {
    for_each = local.fleet_alert_group.rules

    content {
      uid            = rule.value.uid
      name           = rule.value.title
      condition      = rule.value.condition
      for            = rule.value.for
      no_data_state  = rule.value.noDataState
      exec_err_state = rule.value.execErrState
      annotations    = rule.value.annotations
      labels         = rule.value.labels
      is_paused      = false

      dynamic "data" {
        for_each = rule.value.data

        content {
          ref_id         = data.value.refId
          datasource_uid = data.value.datasourceUid
          query_type     = try(data.value.queryType, "")
          model          = jsonencode(data.value.model)

          relative_time_range {
            from = data.value.relativeTimeRange.from
            to   = data.value.relativeTimeRange.to
          }
        }
      }
    }
  }
}

resource "grafana_dashboard_public" "fleet_status" {
  provider               = grafana.stack
  dashboard_uid          = "cogni-fleet-status"
  is_enabled             = true
  share                  = "public"
  time_selection_enabled = false
  annotations_enabled    = false
}

output "production_checks" {
  description = "Synthetic Monitoring check IDs keyed by production node slug."
  value = {
    for slug, check in grafana_synthetic_monitoring_check.production_readyz :
    slug => check.id
  }
}

output "public_status_uid" {
  description = "Public dashboard UID used to construct the redacted fleet status URL."
  value       = grafana_dashboard_public.fleet_status.uid
}
