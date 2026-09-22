# Grafana Alerting

Grafana Git Sync does not currently sync alerting resources. Keep Grafana-managed alert rules, contact points, notification policies, mute timings, and templates here, then apply them through Terraform/OpenTofu or the Grafana alerting provisioning API.

Preferred shape:

```text
infra/grafana/alerts/
├── terraform/          # provider resources once Grafana credentials are wired
└── exports/            # reviewed exports from Grafana before conversion
```

Do not commit secrets, contact-point tokens, webhook URLs, or decrypted exports.

Grafana Cloud does not support local configuration-file alert provisioning. A
reviewed YAML file in this directory is the source contract, not proof that the
rule is live. Closure requires applying it through the existing Grafana alerting
provisioning API (or Terraform), then reading the rule back and exercising its
query against live telemetry.
