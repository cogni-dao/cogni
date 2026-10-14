terraform {
  required_version = ">= 1.8.0"

  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 4.45"
    }
  }
}

data "terraform_remote_state" "grafana_bootstrap" {
  backend = "local"
  config = {
    path = "${path.module}/../cloud-bootstrap/terraform.tfstate"
  }
}

provider "grafana" {
  alias = "stack"
  url   = data.terraform_remote_state.grafana_bootstrap.outputs.grafana_url
  auth  = data.terraform_remote_state.grafana_bootstrap.outputs.grafana_auth
}

provider "grafana" {
  alias           = "sm"
  sm_access_token = data.terraform_remote_state.grafana_bootstrap.outputs.sm_access_token
  sm_url          = data.terraform_remote_state.grafana_bootstrap.outputs.sm_url
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
        environment    = environment
        node_slug      = entry.name
        database_tier  = try(entry.database[environment].tier, null)
        budget_profile = try(entry.database[environment].budget_profile, null)
        database_name  = "cogni_${replace(entry.name, "-", "_")}"
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

  shared_database_targets = {
    for key, target in local.environment_targets : key => target
    if target.database_tier == "shared" && target.budget_profile != null
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

  reliability_policy = jsondecode(
    file("${path.module}/../../../packages/node-contracts/src/reliability-policy.v1.json")
  )
  reliability_warning_rules = {
    io = {
      uid       = "reliability-io-warning"
      title     = "host I/O pressure sustained above warning threshold"
      metric    = "cogni_reliability_v1_io_pressure_percent"
      threshold = local.reliability_policy.signals.ioPressurePercent.warning
      direction = local.reliability_policy.signals.ioPressurePercent.direction
    }
    connections = {
      uid       = "reliability-connections-warning"
      title     = "PostgreSQL connections sustained above warning threshold"
      metric    = "cogni_reliability_v1_connections_percent"
      threshold = local.reliability_policy.signals.connectionsPercent.warning
      direction = local.reliability_policy.signals.connectionsPercent.direction
    }
    memory = {
      uid       = "reliability-memory-warning"
      title     = "memory headroom sustained below warning threshold"
      metric    = "cogni_reliability_v1_memory_headroom_percent"
      threshold = local.reliability_policy.signals.memoryHeadroomPercent.warning
      direction = local.reliability_policy.signals.memoryHeadroomPercent.direction
    }
    disk = {
      uid       = "reliability-disk-warning"
      title     = "root disk headroom sustained below warning threshold"
      metric    = "cogni_reliability_v1_disk_headroom_percent"
      threshold = local.reliability_policy.signals.diskHeadroomPercent.warning
      direction = local.reliability_policy.signals.diskHeadroomPercent.direction
    }
  }
}

data "grafana_folder" "reliability" {
  provider = grafana.stack
  uid      = "cogni-reliability"
}

# The public fleet dashboard is an OpenTofu-owned resource. Git Sync cannot
# update the current dashboard because it was created as an unmanaged Grafana
# resource; keeping its JSON in Git without declaring ownership creates false
# desired state. `overwrite` adopts the stable UID without changing its public
# share identity.
resource "grafana_dashboard" "fleet_status" {
  provider    = grafana.stack
  folder      = data.grafana_folder.reliability.uid
  config_json = file("${path.module}/../dashboards/operator/fleet-status.json")
  overwrite   = true
}

resource "grafana_dashboard" "fleet_capacity" {
  provider    = grafana.stack
  folder      = data.grafana_folder.reliability.uid
  config_json = file("${path.module}/../dashboards/operator/fleet-capacity.json")
  overwrite   = true
}

# Fleet alerting is query-only. Rules continue evaluating and retain current
# state/history in Grafana, but no notification integration may push alerts.
# The provider requires a structurally valid receiver even for a muted route;
# the null receiver below exists only behind an all-time mute.
resource "grafana_mute_timing" "query_only" {
  provider = grafana.stack
  name     = "cogni-query-only"

  # Grafana defines an empty interval as muted for all time.
  intervals {}
}

# Grafana requires every policy to name a contact point. This deliberately
# unreachable receiver is structural only and is always protected by the
# all-time mute below; it contains no human address or secret.
resource "grafana_contact_point" "query_only" {
  provider = grafana.stack
  name     = "cogni-query-only-null"

  webhook {
    url                     = "https://query-only.invalid/cogni"
    disable_resolve_message = true
  }
}

resource "grafana_notification_policy" "query_only" {
  provider        = grafana.stack
  contact_point   = grafana_contact_point.query_only.name
  group_by        = ["grafana_folder", "alertname"]
  group_wait      = "30s"
  group_interval  = "5m"
  repeat_interval = "12h"

  # A matcher-free child consumes every alert and mutes notification delivery.
  policy {
    contact_point = grafana_contact_point.query_only.name
    mute_timings  = [grafana_mute_timing.query_only.name]
    continue      = false
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
  basic_metrics_only = true
  folder_uid         = data.grafana_folder.reliability.uid

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

# Versioned current-state contract. Every consumer (actuator, alerts, dashboard)
# reads these recorded percent series; policy math is evaluated exactly once.
resource "grafana_rule_group" "reliability_recording" {
  provider         = grafana.stack
  for_each         = local.shared_database_targets
  name             = "reliability-status-v1-${replace(each.key, "/", "-")}"
  folder_uid       = data.grafana_folder.reliability.uid
  interval_seconds = 60

  dynamic "rule" {
    for_each = {
      io_pressure = {
        metric = "cogni_reliability_v1_io_pressure_percent"
        expr   = "(100 * max by (substrate_host) (rate(node_pressure_io_stalled_seconds_total{env=\"${each.value.environment}\",substrate_host!=\"\"}[5m]))) and on (substrate_host) (time() - min by (substrate_host) (timestamp(node_pressure_io_stalled_seconds_total{env=\"${each.value.environment}\",substrate_host!=\"\"})) <= ${local.reliability_policy.evidenceTtlMs / 1000})"
      }
      connections = {
        metric = "cogni_reliability_v1_connections_percent"
        expr   = "(100 * sum by (substrate_host) (pg_stat_database_numbackends{env=\"${each.value.environment}\",substrate_host!=\"\"}) / on (substrate_host) max by (substrate_host) (pg_settings_max_connections{env=\"${each.value.environment}\",substrate_host!=\"\"})) and on (substrate_host) (time() - min by (substrate_host) (timestamp(pg_stat_database_numbackends{env=\"${each.value.environment}\",substrate_host!=\"\"})) <= ${local.reliability_policy.evidenceTtlMs / 1000}) and on (substrate_host) (time() - min by (substrate_host) (timestamp(pg_settings_max_connections{env=\"${each.value.environment}\",substrate_host!=\"\"})) <= ${local.reliability_policy.evidenceTtlMs / 1000})"
      }
      memory_headroom = {
        metric = "cogni_reliability_v1_memory_headroom_percent"
        expr   = "(100 * min by (substrate_host) (node_memory_MemAvailable_bytes{env=\"${each.value.environment}\",substrate_host!=\"\"} / node_memory_MemTotal_bytes{env=\"${each.value.environment}\",substrate_host!=\"\"})) and on (substrate_host) (time() - min by (substrate_host) (timestamp(node_memory_MemAvailable_bytes{env=\"${each.value.environment}\",substrate_host!=\"\"})) <= ${local.reliability_policy.evidenceTtlMs / 1000}) and on (substrate_host) (time() - min by (substrate_host) (timestamp(node_memory_MemTotal_bytes{env=\"${each.value.environment}\",substrate_host!=\"\"})) <= ${local.reliability_policy.evidenceTtlMs / 1000})"
      }
      disk_headroom = {
        metric = "cogni_reliability_v1_disk_headroom_percent"
        expr   = "(100 * min by (substrate_host) (node_filesystem_avail_bytes{env=\"${each.value.environment}\",substrate_host!=\"\",mountpoint=\"/\"} / node_filesystem_size_bytes{env=\"${each.value.environment}\",substrate_host!=\"\",mountpoint=\"/\"})) and on (substrate_host) (time() - min by (substrate_host) (timestamp(node_filesystem_avail_bytes{env=\"${each.value.environment}\",substrate_host!=\"\"})) <= ${local.reliability_policy.evidenceTtlMs / 1000}) and on (substrate_host) (time() - min by (substrate_host) (timestamp(node_filesystem_size_bytes{env=\"${each.value.environment}\",substrate_host!=\"\"})) <= ${local.reliability_policy.evidenceTtlMs / 1000})"
      }
      database_backends_share = {
        metric = "cogni_reliability_v1_database_backends_share_percent"
        expr   = "(100 * sum by (substrate_host) (avg_over_time(pg_stat_database_numbackends{env=\"${each.value.environment}\",substrate_host!=\"\",datname=\"${each.value.database_name}\"}[5m])) / on (substrate_host) clamp_min(sum by (substrate_host) (avg_over_time(pg_stat_database_numbackends{env=\"${each.value.environment}\",substrate_host!=\"\",datname!~\"template.*|postgres\"}[5m])), 1)) and on (substrate_host) (time() - min by (substrate_host) (timestamp(pg_stat_database_numbackends{env=\"${each.value.environment}\",substrate_host!=\"\"})) <= ${local.reliability_policy.evidenceTtlMs / 1000})"
      }
      database_physical_reads_share = {
        metric = "cogni_reliability_v1_database_physical_reads_share_percent"
        expr   = "(100 * sum by (substrate_host) (increase(pg_stat_database_blks_read{env=\"${each.value.environment}\",substrate_host!=\"\",datname=\"${each.value.database_name}\"}[5m])) / on (substrate_host) clamp_min(sum by (substrate_host) (increase(pg_stat_database_blks_read{env=\"${each.value.environment}\",substrate_host!=\"\",datname!~\"template.*|postgres\"}[5m])), 1)) and on (substrate_host) (time() - min by (substrate_host) (timestamp(pg_stat_database_blks_read{env=\"${each.value.environment}\",substrate_host!=\"\"})) <= ${local.reliability_policy.evidenceTtlMs / 1000})"
      }
      database_temp_bytes_share = {
        metric = "cogni_reliability_v1_database_temp_bytes_share_percent"
        expr   = "(100 * sum by (substrate_host) (increase(pg_stat_database_temp_bytes{env=\"${each.value.environment}\",substrate_host!=\"\",datname=\"${each.value.database_name}\"}[5m])) / on (substrate_host) clamp_min(sum by (substrate_host) (increase(pg_stat_database_temp_bytes{env=\"${each.value.environment}\",substrate_host!=\"\",datname!~\"template.*|postgres\"}[5m])), 1)) and on (substrate_host) (time() - min by (substrate_host) (timestamp(pg_stat_database_temp_bytes{env=\"${each.value.environment}\",substrate_host!=\"\"})) <= ${local.reliability_policy.evidenceTtlMs / 1000})"
      }
    }

    content {
      name      = "${rule.key}-${each.value.environment}-${each.value.node_slug}"
      for       = "0s"
      is_paused = false
      labels = {
        policy_version = "reliability-status-v1"
        environment    = each.value.environment
        node_slug      = each.value.node_slug
        database_tier  = each.value.database_tier
        budget_profile = each.value.budget_profile
      }

      record {
        metric                = rule.value.metric
        from                  = "A"
        target_datasource_uid = "grafanacloud-prom"
      }

      data {
        ref_id         = "A"
        datasource_uid = "grafanacloud-prom"
        model = jsonencode({
          datasource = { type = "prometheus", uid = "grafanacloud-prom" }
          expr       = rule.value.expr
          instant    = true
          refId      = "A"
        })
        relative_time_range {
          from = 600
          to   = 0
        }
      }
    }
  }

}

resource "grafana_rule_group" "fleet_capacity" {
  provider         = grafana.stack
  for_each         = local.environment_configs
  name             = "${local.fleet_alert_group.name}-${each.key}"
  folder_uid       = data.grafana_folder.reliability.uid
  interval_seconds = 60

  lifecycle {
    precondition {
      condition = alltrue([
        for count in values(local.environment_target_counts) : count > 0
      ])
      error_message = "Candidate-a, preview, and production must each have at least one catalog-derived monitoring target."
    }
  }

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

      # Keep evaluation/query surfaces live while suppressing every push.
      # Explicit rule routing prevents a mutable root policy from re-enabling
      # fleet notifications later.
      notification_settings {
        contact_point = grafana_contact_point.query_only.name
        mute_timings  = [grafana_mute_timing.query_only.name]
      }

      dynamic "data" {
        for_each = rule.value.data

        content {
          ref_id         = data.value.refId
          datasource_uid = data.value.datasourceUid
          query_type     = try(data.value.queryType, data.value.model.queryType, "")
          model = replace(
            jsonencode(data.value.model),
            "__ENVIRONMENT__",
            each.key,
          )

          relative_time_range {
            from = try(data.value.relativeTimeRange.from, 0)
            to   = try(data.value.relativeTimeRange.to, 0)
          }
        }
      }
    }
  }

  # Suffix-only rules consume the same JSON policy contract as the TypeScript
  # evaluator. This avoids threshold math drifting between API and Grafana.
  dynamic "rule" {
    for_each = local.reliability_warning_rules

    content {
      uid = length("${rule.value.uid}-${each.value.uid_suffix}") <= 40 ? "${rule.value.uid}-${each.value.uid_suffix}" : format(
        "%s-%s",
        substr("${rule.value.uid}-${each.value.uid_suffix}", 0, 26),
        substr(sha256("${rule.value.uid}-${each.value.uid_suffix}"), 0, 12)
      )
      name           = "${each.key} ${rule.value.title}"
      condition      = "THRESHOLD"
      for            = contains(["io", "connections"], rule.key) ? "5m" : "10m"
      no_data_state  = "Alerting"
      exec_err_state = "Alerting"
      annotations = {
        summary = "${each.key} ${rule.value.title}."
      }
      labels = {
        environment    = each.key
        severity       = "warning"
        proof_class    = "run"
        policy_version = local.reliability_policy.version
      }
      is_paused = false

      notification_settings {
        contact_point = grafana_contact_point.query_only.name
        mute_timings  = [grafana_mute_timing.query_only.name]
      }

      data {
        ref_id         = "SIGNAL"
        datasource_uid = "grafanacloud-prom"
        model = jsonencode({
          datasource = { type = "prometheus", uid = "grafanacloud-prom" }
          expr       = "${rule.value.direction == "above" ? "max" : "min"}(${rule.value.metric}{environment=\"${each.key}\",policy_version=\"${local.reliability_policy.version}\"})"
          instant    = true
          refId      = "SIGNAL"
        })
        relative_time_range {
          from = 900
          to   = 0
        }
      }

      data {
        ref_id         = "THRESHOLD"
        datasource_uid = "__expr__"
        model = jsonencode({
          type       = "threshold"
          expression = "SIGNAL"
          conditions = [{
            evaluator = {
              type   = rule.value.direction == "above" ? "gt" : "lt"
              params = [rule.value.threshold]
            }
          }]
          refId = "THRESHOLD"
        })
        relative_time_range {
          from = 0
          to   = 0
        }
      }
    }
  }
}

resource "grafana_dashboard_public" "fleet_status" {
  provider               = grafana.stack
  dashboard_uid          = grafana_dashboard.fleet_status.uid
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
  value       = "${trimsuffix(data.terraform_remote_state.grafana_bootstrap.outputs.grafana_url, "/")}/public-dashboards/${grafana_dashboard_public.fleet_status.access_token}"
  sensitive   = true
}
