# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# k3s VM provisioning — extends the cherry/base pattern.
# Provisions a Cherry Servers VM with k3s installed via cloud-init.
# Argo CD install is included in cloud-init but exercised in task.0149.

terraform {
  required_providers {
    cherryservers = {
      source = "cherryservers/cherryservers"
    }
  }
}

resource "cherryservers_ssh_key" "k3s" {
  name       = "cogni-${var.environment}-k3s-deploy"
  public_key = file("${path.module}/${var.public_key_path}")
}

resource "cherryservers_server" "k3s" {
  plan       = var.plan
  hostname   = "${var.environment}-${var.vm_name_prefix}"
  project_id = var.project_id
  region     = var.region
  image      = "ubuntu_22_04"

  ssh_key_ids = [cherryservers_ssh_key.k3s.id]

  user_data = base64encode(templatefile("${path.module}/bootstrap-k3s.yaml", {
    ghcr_deploy_username   = var.ghcr_deploy_username
    ghcr_deploy_token      = var.ghcr_deploy_token
    system_reserved_memory = var.system_reserved_memory
    eviction_hard_memory   = var.eviction_hard_memory
  }))

  allow_reinstall = true

  lifecycle {
    ignore_changes = [user_data]
  }
}

# Bootstrap health check — waits for cloud-init to complete and validates k3s
resource "null_resource" "bootstrap_health_check" {
  count      = var.ssh_private_key != "" ? 1 : 0
  depends_on = [cherryservers_server.k3s]

  triggers = {
    server_id = cherryservers_server.k3s.id
  }

  connection {
    type        = "ssh"
    host        = [for ip in cherryservers_server.k3s.ip_addresses : ip.address if ip.type == "primary-ip"][0]
    user        = "root"
    private_key = var.ssh_private_key
    timeout     = "10m"
  }

  provisioner "remote-exec" {
    inline = [
      "bash -lc 'set -euo pipefail; cloud-init status --wait; test -f /var/lib/cogni/bootstrap.ok || { cat /var/lib/cogni/bootstrap.fail 2>/dev/null; exit 1; }; k3s --version; kubectl get nodes'"
    ]
  }
}
