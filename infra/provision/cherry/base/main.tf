# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

terraform {
    required_providers {
        cherryservers = {
            source = "cherryservers/cherryservers"
        }
    }
    # TODO: Configure remote backend when ready
    # backend "s3" {
    #   bucket = "your-terraform-state-bucket"
    #   key    = "cherry-base-${var.environment}.tfstate"
    #   region = "us-east-1"
    # }
}
# Set the variable value in variables.tf file.
# Ensure the CHERRY_AUTH_TOKEN or CHERRY_AUTH_TOKEN environment variable is set and Exported: https://portal.cherryservers.com/settings/api-keys
# 

#Create a new server:
resource "cherryservers_server" "server" {
    plan         = var.plan
    hostname     = "${var.environment}-${var.vm_name_prefix}"
    project_id   = var.project_id
    region       = var.region
    image        = "ubuntu_22_04"
    ssh_key_ids  = [cherryservers_ssh_key.key.id]
    user_data    = base64encode(templatefile("${path.module}/bootstrap.yaml", {
      ghcr_deploy_username = var.ghcr_deploy_username
      ghcr_deploy_token    = var.ghcr_deploy_token
      cogni_repo_url       = var.cogni_repo_url
      cogni_repo_ref       = var.cogni_repo_ref
      sops_age_private_key = var.sops_age_private_key
      harden_script        = file("${path.module}/../harden-docker-public-ports.sh")
      system_reserved_memory = var.system_reserved_memory
      eviction_hard_memory   = var.eviction_hard_memory
    }))
    allow_reinstall = true
    
    lifecycle {
        ignore_changes = [user_data]
    }
}

resource "cherryservers_ssh_key" "key" {
    name       = "${var.vm_name_prefix}-${var.environment}-deploy"
    public_key = file("${path.module}/${var.public_key_path}")
}

output "vm_host" {
  description = "Public IP address of the provisioned VM"
  value       = [for ip in cherryservers_server.server.ip_addresses : ip.address if ip.type == "primary-ip"][0]
  sensitive   = false
}

# Health check: verify bootstrap completed and Docker is working
# Skipped if ssh_private_key is empty
resource "null_resource" "bootstrap_health_check" {
  count = var.ssh_private_key != "" ? 1 : 0

  depends_on = [cherryservers_server.server]

  triggers = {
    server_id = cherryservers_server.server.id
  }

  connection {
    type        = "ssh"
    host        = [for ip in cherryservers_server.server.ip_addresses : ip.address if ip.type == "primary-ip"][0]
    user        = "root"
    private_key = var.ssh_private_key
    timeout     = "10m"
  }

  provisioner "remote-exec" {
    inline = [
      "bash -lc 'set -euo pipefail; echo \"Waiting for cloud-init...\"; cloud-init status --wait; echo \"Checking bootstrap marker...\"; test -f /var/lib/cogni/bootstrap.ok || { echo \"FAIL: missing bootstrap.ok\"; cat /var/lib/cogni/bootstrap.fail 2>/dev/null || true; tail -n 200 /var/log/cloud-init-output.log || true; tail -n 200 /var/log/cogni-bootstrap.log || true; exit 1; }; echo \"Checking Docker...\"; docker version; docker compose version; echo \"Checking k3s...\"; kubectl get nodes; echo \"Checking Argo CD...\"; kubectl -n argocd get deploy argocd-server -o jsonpath=\"{.status.availableReplicas}\" | grep -q 1; echo \"Bootstrap health check passed\"'"
    ]
  }
}