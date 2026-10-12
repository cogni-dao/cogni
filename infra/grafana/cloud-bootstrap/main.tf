terraform {
  required_version = ">= 1.8.0"

  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 4.45"
    }
  }
}

provider "grafana" {
  alias = "cloud"
}

data "grafana_cloud_stack" "current" {
  provider = grafana.cloud
  slug     = var.grafana_stack_slug
}

resource "grafana_cloud_stack_service_account" "fleet_reconciler" {
  provider   = grafana.cloud
  stack_slug = data.grafana_cloud_stack.current.slug
  name       = "cogni-fleet-opentofu"
  role       = "Admin"
}

resource "grafana_cloud_stack_service_account_token" "fleet_reconciler" {
  provider           = grafana.cloud
  stack_slug         = data.grafana_cloud_stack.current.slug
  name               = "cogni-fleet-opentofu"
  service_account_id = grafana_cloud_stack_service_account.fleet_reconciler.id
}

resource "grafana_cloud_access_policy" "synthetic_publisher" {
  provider = grafana.cloud
  region   = data.grafana_cloud_stack.current.region_slug
  name     = "cogni-fleet-synthetic-publisher"
  scopes   = ["stacks:read", "metrics:write", "logs:write", "traces:write"]

  realm {
    type       = "stack"
    identifier = tostring(data.grafana_cloud_stack.current.id)
  }
}

resource "grafana_cloud_access_policy_token" "synthetic_publisher" {
  provider         = grafana.cloud
  region           = grafana_cloud_access_policy.synthetic_publisher.region
  access_policy_id = grafana_cloud_access_policy.synthetic_publisher.policy_id
  name             = "cogni-fleet-synthetic-publisher"
}

resource "grafana_synthetic_monitoring_installation" "fleet" {
  provider              = grafana.cloud
  stack_id              = tostring(data.grafana_cloud_stack.current.id)
  metrics_publisher_key = grafana_cloud_access_policy_token.synthetic_publisher.token
}

variable "grafana_stack_slug" {
  description = "Existing Grafana Cloud stack that receives fleet metrics and logs."
  type        = string
  default     = "derekg1729"
}

output "grafana_url" {
  value = data.grafana_cloud_stack.current.url
}

output "grafana_auth" {
  value     = grafana_cloud_stack_service_account_token.fleet_reconciler.key
  sensitive = true
}

output "sm_access_token" {
  value     = grafana_synthetic_monitoring_installation.fleet.sm_access_token
  sensitive = true
}

output "sm_url" {
  value = grafana_synthetic_monitoring_installation.fleet.stack_sm_api_url
}
