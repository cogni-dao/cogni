// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// Package controller aggregates the provider's controllers.
package controller

import (
	"time"

	"github.com/crossplane/crossplane-runtime/pkg/logging"
	ctrl "sigs.k8s.io/controller-runtime"

	"github.com/cogni-dao/provider-akash/internal/controller/akashdeployment"
	"github.com/cogni-dao/provider-akash/internal/controller/config"
)

// Setup wires every provider controller into the manager.
func Setup(mgr ctrl.Manager, l logging.Logger, pollInterval time.Duration) error {
	if err := config.Setup(mgr, l); err != nil {
		return err
	}
	return akashdeployment.Setup(mgr, l, pollInterval)
}
