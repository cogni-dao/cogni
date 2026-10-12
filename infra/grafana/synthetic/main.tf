terraform {
  required_version = ">= 1.8.0"

  # The fleet monitor must not depend on a laptop or any database it observes.
  # Bucket, endpoint, and prefix-scoped credentials are supplied at init time;
  # no backend credential belongs in git or a saved plan. The S3 protocol keeps
  # this portable across AWS S3 and versioned MinIO/Ceph-compatible stores.
  backend "s3" {
    key          = "grafana/fleet-reliability/terraform.tfstate"
    use_lockfile = true
    encrypt      = true
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
  environment_configs = {
    candidate-a = {
      primary_host = "test.${var.apex_domain}"
      node_suffix  = "-test"
      uid_suffix   = "candidate-a"
    }
    preview = {
      primary_host = "preview.${var.apex_domain}"
      node_suffix  = "-preview"
      uid_suffix   = "preview"
    }
    production = {
      primary_host = var.apex_domain
      node_suffix  = ""
      uid_suffix   = "production"
    }
  }

  catalog = [
    for catalog_file in fileset("${path.module}/../../catalog", "*.yaml") :
    yamldecode(file("${path.module}/../../catalog/${catalog_file}"))
  ]

  # One derived target map is the parity boundary: a catalog slot cannot be
  # added to one of the three environments without gaining the same check.
  environment_targets = merge([
    for environment, config in local.environment_configs : {
      for entry in local.catalog : "${environment}/${entry.name}" => {
        environment = environment
        node_slug   = entry.name
        host = (
          try(entry.is_primary_host, false)
          ? config.primary_host
          : "${entry.name}${config.node_suffix}.${var.apex_domain}"
        )
      }
      if entry.type == "node" && contains(try(entry.envs, []), environment)
    }
  ]...)

  environment_target_counts = {
    for environment in keys(local.environment_configs) : environment =>
    length([
      for target in values(local.environment_targets) : target
      if target.environment == environment
    ])
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

  lifecycle {
    precondition {
      condition = alltrue([
        for count in values(local.environment_target_counts) : count > 0
      ])
      error_message = "Candidate-a, preview, and production must each have at least one catalog-derived monitoring target."
    }
  }
}

resource "grafana_synthetic_monitoring_check" "environment_readyz" {
  provider = grafana.sm
  for_each = local.environment_targets

  job                = "cogni-${each.value.environment}-${each.value.node_slug}-readyz"
  target             = "https://${each.value.host}/readyz"
  enabled            = true
  probes             = local.public_probe_ids
  frequency          = 60000
  timeout            = 5000
  alert_sensitivity  = "high"
  basic_metrics_only = true
  folder_uid         = grafana_folder.reliability.uid

  labels = {
    environment = each.value.environment
    node_slug   = each.value.node_slug
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
  for_each         = local.environment_configs
  name             = "${local.fleet_alert_group.name}-${each.key}"
  folder_uid       = grafana_folder.reliability.uid
  interval_seconds = 60
  org_id           = local.fleet_alert_group.orgId

  dynamic "rule" {
    for_each = local.fleet_alert_group.rules

    content {
      uid            = "${rule.value.uid}-${each.value.uid_suffix}"
      name           = replace(rule.value.title, "__ENVIRONMENT__", each.key)
      condition      = rule.value.condition
      for            = rule.value.for
      no_data_state  = rule.value.noDataState
      exec_err_state = rule.value.execErrState
      annotations = {
        for key, value in rule.value.annotations :
        key => replace(value, "__ENVIRONMENT__", each.key)
      }
      labels = merge(rule.value.labels, {
        environment = each.key
      })
      is_paused = false

      dynamic "data" {
        for_each = rule.value.data

        content {
          ref_id         = data.value.refId
          datasource_uid = data.value.datasourceUid
          query_type     = try(data.value.queryType, "")
          model = replace(
            jsonencode(data.value.model),
            "__ENVIRONMENT__",
            each.key,
          )

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

output "environment_checks" {
  description = "Synthetic Monitoring check IDs keyed by environment/node slug."
  value = {
    for target, check in grafana_synthetic_monitoring_check.environment_readyz :
    target => check.id
  }
}

output "environment_target_counts" {
  description = "Catalog-derived target count for each monitored environment."
  value       = local.environment_target_counts
}

output "public_status_url" {
  description = "Anonymous URL for the redacted fleet status dashboard."
  value       = "${trimsuffix(var.grafana_url, "/")}/public-dashboards/${grafana_dashboard_public.fleet_status.access_token}"
}
