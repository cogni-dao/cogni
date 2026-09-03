// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// Package config wires the ProviderConfig controller, which garbage-collects
// ProviderConfigUsage records when the managed resources referencing them go
// away. It is standard crossplane-runtime plumbing.
package config

import (
	"github.com/crossplane/crossplane-runtime/pkg/event"
	"github.com/crossplane/crossplane-runtime/pkg/logging"
	"github.com/crossplane/crossplane-runtime/pkg/reconciler/providerconfig"
	"github.com/crossplane/crossplane-runtime/pkg/resource"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/controller"

	"github.com/cogni-dao/provider-akash/apis/v1alpha1"
)

// Setup adds the ProviderConfig controller to the manager.
func Setup(mgr ctrl.Manager, l logging.Logger) error {
	name := "providerconfig/" + v1alpha1.ProviderConfigGroupVersionKind.String()

	of := resource.ProviderConfigKinds{
		Config:    v1alpha1.ProviderConfigGroupVersionKind,
		Usage:     v1alpha1.ProviderConfigUsageGroupVersionKind,
		UsageList: v1alpha1.SchemeGroupVersion.WithKind("ProviderConfigUsageList"),
	}

	r := providerconfig.NewReconciler(mgr, of,
		providerconfig.WithLogger(l.WithValues("controller", name)),
		providerconfig.WithRecorder(event.NewAPIRecorder(mgr.GetEventRecorderFor(name))),
	)

	return ctrl.NewControllerManagedBy(mgr).
		Named(name).
		For(&v1alpha1.ProviderConfig{}).
		Watches(&v1alpha1.ProviderConfigUsage{}, &resource.EnqueueRequestForProviderConfig{}).
		WithOptions(controller.Options{MaxConcurrentReconciles: 1}).
		Complete(r)
}
