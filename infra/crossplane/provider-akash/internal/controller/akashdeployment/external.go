// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// Package akashdeployment holds the crash-safe reconcile logic for the
// AkashDeployment managed resource.
//
// CRASH-SAFETY (the whole point of this provider). The community
// overlock-network/provider-akash double-spends escrow on a crash because it
// mints a random time.Now() dseq inside Create and only persists the
// external-name AFTER a successful create. If it dies between broadcasting the
// create and writing the external-name, the next reconcile sees no external-name
// and creates AGAIN — a second paid lease.
//
// This provider closes that window two independent ways:
//
//  1. DETERMINISTIC KEY + server idempotency. Create sends the workload's stable
//     NodeID as the dedupe key; the Console is idempotent on it, so a re-issued
//     create returns the SAME lease. (Never time.Now().)
//
//  2. ADOPTION in Observe. When the external-name is not yet persisted, Observe
//     does NOT assume the resource is absent: it lists by the deterministic key
//     (FindByKey) and, if an active deployment exists, ADOPTS it by writing its
//     lease id as the external-name. Crossplane persists that annotation, so the
//     next Create is never issued.
//
// Either mechanism alone prevents a double-spend; together they are belt and
// braces. The adoption path mirrors the operator's own allocationCursor /
// findAllocationSince recovery (READ for reference, never modified):
// nodes/operator/app/src/adapters/server/compute/akash-compute.adapter.ts.
package akashdeployment

import (
	"context"
	"fmt"
	"reflect"

	xpv1 "github.com/crossplane/crossplane-runtime/apis/common/v1"
	"github.com/crossplane/crossplane-runtime/pkg/errors"
	"github.com/crossplane/crossplane-runtime/pkg/meta"
	"github.com/crossplane/crossplane-runtime/pkg/reconciler/managed"
	"github.com/crossplane/crossplane-runtime/pkg/resource"

	"github.com/cogni-dao/provider-akash/apis/v1alpha1"
	"github.com/cogni-dao/provider-akash/internal/console"
)

// external is the managed.ExternalClient for AkashDeployment. It depends only on
// a console.Client, so the crash-safe logic is unit-testable against a fake.
type external struct {
	client console.Client
}

var _ managed.ExternalClient = &external{}

// desiredRequest builds the Console create/update body from the MR spec. NodeID
// is the deterministic adoption/idempotency key.
func desiredRequest(cr *v1alpha1.AkashDeployment) console.CreateRequest {
	services := make([]console.Service, 0, len(cr.Spec.ForProvider.Services))
	for _, s := range cr.Spec.ForProvider.Services {
		services = append(services, console.Service{
			Name:       s.Name,
			Image:      s.Image,
			CPUUnits:   s.CPUUnits,
			MemoryMi:   s.MemoryMi,
			StorageMi:  s.StorageMi,
			Port:       s.Port,
			Visibility: s.Visibility,
		})
	}
	return console.CreateRequest{
		NodeID:     cr.Spec.ForProvider.NodeID,
		Name:       cr.GetName(),
		PublicHost: cr.Spec.ForProvider.PublicHost,
		Services:   services,
	}
}

// upToDate reports whether the observed deployment already matches desired. It
// compares the echoed desired fields directly (robust across the JSON round
// trip) rather than a cross-language spec hash.
func upToDate(cr *v1alpha1.AkashDeployment, dep *console.Deployment) bool {
	want := desiredRequest(cr)
	if dep.State != "active" {
		return false
	}
	if dep.PublicHost != want.PublicHost {
		return false
	}
	return reflect.DeepEqual(dep.Services, want.Services)
}

// setObserved mirrors the Console view onto the MR status.
func setObserved(cr *v1alpha1.AkashDeployment, dep *console.Deployment) {
	cr.Status.AtProvider = v1alpha1.AkashDeploymentObservation{
		LeaseID:   dep.LeaseID,
		State:     dep.State,
		Endpoints: dep.Endpoints,
	}
}

// Observe implements managed.ExternalClient.
//
// External-name is the lease id. Two paths:
//   - external-name SET   -> GET by lease (404 => gone => recreate).
//   - external-name EMPTY -> ADOPT: FindByKey(nodeId). If an active deployment
//     exists, we captured a lease that a prior Create broadcast but never
//     persisted; adopt it (write external-name) instead of creating again.
func (e *external) Observe(ctx context.Context, mg resource.Managed) (managed.ExternalObservation, error) {
	cr, ok := mg.(*v1alpha1.AkashDeployment)
	if !ok {
		return managed.ExternalObservation{}, errors.New("managed resource is not an AkashDeployment")
	}

	leaseID := meta.GetExternalName(cr)

	if leaseID == "" {
		// ADOPTION PATH — the crash-safe recovery.
		dep, found, err := e.client.FindByKey(ctx, cr.Spec.ForProvider.NodeID)
		if err != nil {
			return managed.ExternalObservation{}, errors.Wrap(err, "adopt: find by key")
		}
		if !found {
			// Genuinely absent; the reconciler will call Create.
			return managed.ExternalObservation{ResourceExists: false}, nil
		}
		// Adopt: persist the discovered lease as the external-name. We return
		// ResourceLateInitialized so Crossplane's reconciler durably writes the
		// recovered annotation back to the API server (the up-to-date path
		// otherwise persists only status). This late-init happens exactly once
		// per adoption: once the external-name is non-empty, subsequent Observes
		// take the GetByLease path and never late-initialize again.
		meta.SetExternalName(cr, dep.LeaseID)
		setObserved(cr, dep)
		cr.SetConditions(xpv1.Available())
		return managed.ExternalObservation{
			ResourceExists:          true,
			ResourceUpToDate:        upToDate(cr, dep),
			ResourceLateInitialized: true,
		}, nil
	}

	dep, found, err := e.client.GetByLease(ctx, leaseID)
	if err != nil {
		return managed.ExternalObservation{}, errors.Wrap(err, "observe: get by lease")
	}
	if !found {
		// The lease we tracked is gone on the Console side; let Crossplane
		// recreate it (deterministic key keeps it safe).
		return managed.ExternalObservation{ResourceExists: false}, nil
	}
	setObserved(cr, dep)
	cr.SetConditions(xpv1.Available())
	return managed.ExternalObservation{
		ResourceExists:   true,
		ResourceUpToDate: upToDate(cr, dep),
	}, nil
}

// Create implements managed.ExternalClient. It sends the deterministic key and
// captures the returned lease id as the external-name EAGERLY. Combined with the
// server's idempotency-on-key, a re-issued Create after a lost external-name
// write returns the same lease — no double-spend.
func (e *external) Create(ctx context.Context, mg resource.Managed) (managed.ExternalCreation, error) {
	cr, ok := mg.(*v1alpha1.AkashDeployment)
	if !ok {
		return managed.ExternalCreation{}, errors.New("managed resource is not an AkashDeployment")
	}

	dep, err := e.client.Create(ctx, desiredRequest(cr))
	if err != nil {
		return managed.ExternalCreation{}, errors.Wrap(err, "create deployment")
	}
	if dep.LeaseID == "" {
		return managed.ExternalCreation{}, fmt.Errorf("create returned empty lease id")
	}
	// Eagerly capture identity. Crossplane persists external-name annotations set
	// during Create even if everything else on the object is discarded.
	meta.SetExternalName(cr, dep.LeaseID)
	setObserved(cr, dep)
	return managed.ExternalCreation{}, nil
}

// Update implements managed.ExternalClient. The lease id is stable across the
// PUT, so drift converges in place with no new escrow.
func (e *external) Update(ctx context.Context, mg resource.Managed) (managed.ExternalUpdate, error) {
	cr, ok := mg.(*v1alpha1.AkashDeployment)
	if !ok {
		return managed.ExternalUpdate{}, errors.New("managed resource is not an AkashDeployment")
	}
	leaseID := meta.GetExternalName(cr)
	if leaseID == "" {
		return managed.ExternalUpdate{}, errors.New("update called without an external-name")
	}
	dep, err := e.client.Update(ctx, leaseID, desiredRequest(cr))
	if err != nil {
		return managed.ExternalUpdate{}, errors.Wrap(err, "update deployment")
	}
	setObserved(cr, dep)
	return managed.ExternalUpdate{}, nil
}

// Delete implements managed.ExternalClient. Release is idempotent.
func (e *external) Delete(ctx context.Context, mg resource.Managed) error {
	cr, ok := mg.(*v1alpha1.AkashDeployment)
	if !ok {
		return errors.New("managed resource is not an AkashDeployment")
	}
	leaseID := meta.GetExternalName(cr)
	if leaseID == "" {
		// Nothing was ever created; safe no-op. Belt-and-braces: also try to
		// release any deployment adopted by key, in case Create broadcast but
		// the external-name never landed.
		dep, found, err := e.client.FindByKey(ctx, cr.Spec.ForProvider.NodeID)
		if err != nil {
			return errors.Wrap(err, "delete: find by key")
		}
		if !found {
			return nil
		}
		leaseID = dep.LeaseID
	}
	if err := e.client.Delete(ctx, leaseID); err != nil {
		return errors.Wrap(err, "delete deployment")
	}
	return nil
}
