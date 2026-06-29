# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

package resource_fit

import rego.v1

deny contains msg if {
	not input.budget.measurement.source
	msg := sprintf("needs_measurement: %s capacity budget is missing measurement.source", [input.env])
}

deny contains msg if {
	some i
	workload := input.workloads[i]
	some j
	missing := workload.missingRequests[j]
	msg := sprintf("missing_request: %s %s %s is missing %s request", [missing.workload, missing.containerType, missing.container, missing.resource])
}

deny contains msg if {
	input.mode == "strict"
	input.totals.memoryOverageMi > 0
	msg := sprintf("memory_over_budget: memory over budget by %dMi including rollout surge", [input.totals.memoryOverageMi])
}

deny contains msg if {
	input.mode == "strict"
	input.totals.cpuOverageMilli > 0
	msg := sprintf("cpu_over_budget: cpu over budget by %dm including rollout surge", [input.totals.cpuOverageMilli])
}

deny contains msg if {
	input.mode == "ratchet"
	not input.baselineTotals
	msg := "baseline_required: ratchet mode requires rendered origin/main baseline totals"
}

deny contains msg if {
	input.mode == "ratchet"
	input.baselineTotals
	input.totals.memoryOverageMi > input.baselineTotals.memoryOverageMi
	increase := input.totals.memoryOverageMi - input.baselineTotals.memoryOverageMi
	msg := sprintf("memory_ratchet_increase: memory overage increased by %dMi versus rendered origin/main", [increase])
}

deny contains msg if {
	input.mode == "ratchet"
	input.baselineTotals
	input.totals.cpuOverageMilli > input.baselineTotals.cpuOverageMilli
	increase := input.totals.cpuOverageMilli - input.baselineTotals.cpuOverageMilli
	msg := sprintf("cpu_ratchet_increase: cpu overage increased by %dm versus rendered origin/main", [increase])
}
