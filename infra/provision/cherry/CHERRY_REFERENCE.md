# Cherry Servers Reference

## API Queries

```bash
export CHERRY_AUTH_TOKEN="<token>"

# Regions
curl -s -H "Authorization: Bearer ${CHERRY_AUTH_TOKEN}" "https://api.cherryservers.com/v1/regions" | jq '.[] | {slug, location}'

# Plans
curl -s -H "Authorization: Bearer ${CHERRY_AUTH_TOKEN}" "https://api.cherryservers.com/v1/plans" | jq '.[] | {slug, name: .specs.memory.name}'

# Plans for region (e.g., Frankfurt = region_id 6)
curl -s -H "Authorization: Bearer ${CHERRY_AUTH_TOKEN}" "https://api.cherryservers.com/v1/plans?region_id=6" | jq '.[].slug'

# Project servers
curl -s -H "Authorization: Bearer ${CHERRY_AUTH_TOKEN}" "https://api.cherryservers.com/v1/projects/${CHERRY_PROJECT_ID}/servers" | jq '.[] | {hostname, region, plan: .plan.slug}'
```

## Regions

| ID  | Slug           | Location    |
| --- | -------------- | ----------- |
| 1   | `LT-Siauliai`  | Lithuania   |
| 2   | `NL-Amsterdam` | Netherlands |
| 3   | `US-Chicago`   | USA         |
| 4   | `SG-Singapore` | Singapore   |
| 5   | `SE-Stockholm` | Sweden      |
| 6   | `DE-Frankfurt` | Germany     |

## Cloud VPS Plans

| Slug                   | Specs                   | EUR/hr |
| ---------------------- | ----------------------- | ------ |
| `B1-1-1gb-20s-shared`  | 1 vCore, 1GB, 20GB SSD  | €0.02  |
| `B1-2-2gb-40s-shared`  | 2 vCore, 2GB, 40GB SSD  | €0.03  |
| `B1-4-4gb-80s-shared`  | 4 vCore, 4GB, 80GB SSD  | -      |
| `B1-6-6gb-100s-shared` | 6 vCore, 6GB, 100GB SSD | -      |

6GB is the largest Cloud VPS. In-place `Upgrade Plan` only works inside the VPS line;
the API rejects VPS → VDS (`400 Plan is not available to be upgraded to`), so moving
to a VDS is a migration (story.5084).

## Cloud VDS Plans (dedicated cores, NVMe)

| Slug                  | Specs                     | USD/mo |
| --------------------- | ------------------------- | ------ |
| `G1-4-16gb-100nv-ded` | 4 vCore, 16GB, 100GB NVMe | $49    |
| `G1-8-32gb-200nv-ded` | 8 vCore, 32GB, 200GB NVMe | $89    |

`production` provisions `G1-4-16gb-100nv-ded` (scripts/setup/provision-env-vm.sh); other envs
stay on `B1-6-6gb-100s-shared`. Override one run with `VM_PLAN=<slug>`.
