// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

package akashdeployment

import (
	"context"
	"testing"

	"github.com/crossplane/crossplane-runtime/pkg/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/cogni-dao/provider-akash/apis/v1alpha1"
	"github.com/cogni-dao/provider-akash/internal/console"
)

// fakeConsole is an in-memory Console faithful to the mock's contract: it is
// idempotent on nodeId (the deterministic key), so a re-issued create returns
// the SAME lease. It also counts create calls and distinct leases minted so a
// test can prove NO second create / NO double-spend.
type fakeConsole struct {
	byLease     map[string]*console.Deployment
	byKey       map[string]string // nodeId -> active leaseId
	nextDseq    int
	createCalls int // total Create() invocations (incl. idempotent repeats)
	minted      int // distinct leases ever minted (double-spend witness)
}

func newFakeConsole() *fakeConsole {
	return &fakeConsole{
		byLease:  map[string]*console.Deployment{},
		byKey:    map[string]string{},
		nextDseq: 1_000_000,
	}
}

func (f *fakeConsole) GetByLease(_ context.Context, leaseID string) (*console.Deployment, bool, error) {
	dep, ok := f.byLease[leaseID]
	if !ok || dep.State == "closed" {
		return nil, false, nil
	}
	return cloneDep(dep), true, nil
}

func (f *fakeConsole) FindByKey(_ context.Context, key string) (*console.Deployment, bool, error) {
	leaseID, ok := f.byKey[key]
	if !ok {
		return nil, false, nil
	}
	dep, ok := f.byLease[leaseID]
	if !ok || dep.State == "closed" {
		return nil, false, nil
	}
	return cloneDep(dep), true, nil
}

func (f *fakeConsole) Create(_ context.Context, req console.CreateRequest) (*console.Deployment, error) {
	f.createCalls++
	// Idempotency / no-double-spend on the deterministic key.
	if leaseID, ok := f.byKey[req.NodeID]; ok {
		if dep := f.byLease[leaseID]; dep != nil && dep.State != "closed" {
			return cloneDep(dep), nil
		}
	}
	leaseID := itoa(f.nextDseq)
	f.nextDseq++
	f.minted++
	dep := &console.Deployment{
		Provider:   "akash",
		LeaseID:    leaseID,
		NodeID:     req.NodeID,
		Name:       req.Name,
		PublicHost: req.PublicHost,
		Services:   req.Services,
		State:      "active",
		Endpoints:  []string{"https://" + req.PublicHost},
	}
	f.byLease[leaseID] = dep
	f.byKey[req.NodeID] = leaseID
	return cloneDep(dep), nil
}

func (f *fakeConsole) Update(_ context.Context, leaseID string, req console.CreateRequest) (*console.Deployment, error) {
	dep := f.byLease[leaseID]
	if dep == nil {
		return nil, nil
	}
	dep.PublicHost = req.PublicHost
	dep.Services = req.Services
	dep.Endpoints = []string{"https://" + req.PublicHost}
	dep.State = "active"
	return cloneDep(dep), nil
}

func (f *fakeConsole) Delete(_ context.Context, leaseID string) error {
	if dep := f.byLease[leaseID]; dep != nil && dep.State != "closed" {
		dep.State = "closed"
		delete(f.byKey, dep.NodeID)
	}
	return nil
}

func cloneDep(d *console.Deployment) *console.Deployment {
	c := *d
	c.Services = append([]console.Service(nil), d.Services...)
	c.Endpoints = append([]string(nil), d.Endpoints...)
	return &c
}

func itoa(i int) string {
	// small, dependency-free int->string
	if i == 0 {
		return "0"
	}
	var b [20]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(b[pos:])
}

func newMR(nodeID string) *v1alpha1.AkashDeployment {
	return &v1alpha1.AkashDeployment{
		ObjectMeta: metav1.ObjectMeta{Name: "demo-node-app"},
		Spec: v1alpha1.AkashDeploymentSpec{
			ForProvider: v1alpha1.AkashDeploymentParameters{
				NodeID:     nodeID,
				PublicHost: "demo-node.example.com",
				Services: []v1alpha1.ServiceSpec{{
					Name:       "app",
					Image:      "ghcr.io/cogni-dao/node-app@sha256:aaaa",
					CPUUnits:   0.5,
					MemoryMi:   512,
					StorageMi:  1024,
					Port:       3000,
					Visibility: "public",
				}},
			},
		},
	}
}

const nodeID = "11111111-1111-1111-1111-111111111111"

// TestCrashMidCreate_ObserveAdopts is THE crux test. It proves that if the
// provider crashes AFTER the create broadcast succeeds but BEFORE Crossplane
// persists the external-name (the exact overlock double-spend window), the next
// Observe ADOPTS the existing deployment by its deterministic key rather than
// issuing a second create. No second lease is minted.
func TestCrashMidCreate_ObserveAdopts(t *testing.T) {
	ctx := context.Background()
	f := newFakeConsole()
	e := &external{client: f}

	// 1) Create succeeds server-side. The provider captures the lease as the
	//    external-name on THIS object...
	created := newMR(nodeID)
	if _, err := e.Create(ctx, created); err != nil {
		t.Fatalf("create: %v", err)
	}
	lease := meta.GetExternalName(created)
	if lease == "" {
		t.Fatalf("create did not capture an external-name")
	}
	if f.createCalls != 1 || f.minted != 1 {
		t.Fatalf("after create: createCalls=%d minted=%d, want 1/1", f.createCalls, f.minted)
	}

	// 2) CRASH: the process dies before the reconciler persists the annotation.
	//    Model that by discarding `created` and re-reading a FRESH object with
	//    NO external-name (as the API server still has it).
	afterCrash := newMR(nodeID)
	if meta.GetExternalName(afterCrash) != "" {
		t.Fatalf("precondition: post-crash object must have no external-name")
	}

	// 3) Observe on the amnesiac object. It MUST adopt, not create.
	obs, err := e.Observe(ctx, afterCrash)
	if err != nil {
		t.Fatalf("observe: %v", err)
	}
	if !obs.ResourceExists {
		t.Fatalf("observe reported ResourceExists=false — would trigger a SECOND create (double-spend)")
	}
	if got := meta.GetExternalName(afterCrash); got != lease {
		t.Fatalf("adoption did not restore the external-name: got %q want %q", got, lease)
	}
	// Adoption must be late-initialized so Crossplane durably persists the
	// recovered external-name (otherwise it re-adopts every reconcile).
	if !obs.ResourceLateInitialized {
		t.Fatalf("adoption did not set ResourceLateInitialized — external-name would not persist")
	}

	// 4) The invariant: NO second create was issued, NO second lease minted.
	if f.createCalls != 1 {
		t.Fatalf("adoption issued extra create calls: createCalls=%d, want 1", f.createCalls)
	}
	if f.minted != 1 {
		t.Fatalf("DOUBLE-SPEND: distinct leases minted=%d, want 1", f.minted)
	}

	// 5) With the external-name now persisted, a subsequent Observe takes the
	//    GetByLease path and does NOT late-initialize again (no churn).
	obs2, err := e.Observe(ctx, afterCrash)
	if err != nil {
		t.Fatalf("observe #2: %v", err)
	}
	if obs2.ResourceLateInitialized {
		t.Fatalf("steady-state Observe late-initialized again — would churn every reconcile")
	}
	if !obs2.ResourceExists {
		t.Fatalf("post-adoption Observe reported ResourceExists=false")
	}
}

// TestServerIdempotency_ReissuedCreate proves the belt-and-braces layer: even if
// adoption were bypassed and Create were re-issued (deterministic key sent), the
// server returns the SAME lease and mints nothing new.
func TestServerIdempotency_ReissuedCreate(t *testing.T) {
	ctx := context.Background()
	f := newFakeConsole()
	e := &external{client: f}

	first := newMR(nodeID)
	if _, err := e.Create(ctx, first); err != nil {
		t.Fatalf("create #1: %v", err)
	}
	lease1 := meta.GetExternalName(first)

	// Re-issue create on a fresh (amnesiac) object.
	second := newMR(nodeID)
	if _, err := e.Create(ctx, second); err != nil {
		t.Fatalf("create #2: %v", err)
	}
	lease2 := meta.GetExternalName(second)

	if lease1 != lease2 {
		t.Fatalf("re-issued create returned a different lease: %q vs %q (double-spend)", lease1, lease2)
	}
	if f.minted != 1 {
		t.Fatalf("DOUBLE-SPEND: distinct leases minted=%d, want 1", f.minted)
	}
	if f.createCalls != 2 {
		t.Fatalf("expected 2 create calls, got %d", f.createCalls)
	}
}

// TestObserve_AbsentThenCreate covers the ordinary first-reconcile: nothing
// exists yet, so Observe reports absent and Create mints exactly one lease.
func TestObserve_AbsentThenCreate(t *testing.T) {
	ctx := context.Background()
	f := newFakeConsole()
	e := &external{client: f}

	cr := newMR(nodeID)
	obs, err := e.Observe(ctx, cr)
	if err != nil {
		t.Fatalf("observe: %v", err)
	}
	if obs.ResourceExists {
		t.Fatalf("observe on empty world reported ResourceExists=true")
	}

	if _, err := e.Create(ctx, cr); err != nil {
		t.Fatalf("create: %v", err)
	}
	if f.minted != 1 {
		t.Fatalf("minted=%d, want 1", f.minted)
	}

	// A subsequent observe (external-name now set) reports exists + up-to-date.
	obs2, err := e.Observe(ctx, cr)
	if err != nil {
		t.Fatalf("observe #2: %v", err)
	}
	if !obs2.ResourceExists || !obs2.ResourceUpToDate {
		t.Fatalf("post-create observe: exists=%v upToDate=%v, want true/true", obs2.ResourceExists, obs2.ResourceUpToDate)
	}
}

// TestObserve_DriftThenUpdate proves drift detection + in-place convergence with
// the SAME lease (no new escrow).
func TestObserve_DriftThenUpdate(t *testing.T) {
	ctx := context.Background()
	f := newFakeConsole()
	e := &external{client: f}

	cr := newMR(nodeID)
	if _, err := e.Create(ctx, cr); err != nil {
		t.Fatalf("create: %v", err)
	}
	leaseBefore := meta.GetExternalName(cr)

	// Drift: bump memory.
	cr.Spec.ForProvider.Services[0].MemoryMi = 1024
	obs, err := e.Observe(ctx, cr)
	if err != nil {
		t.Fatalf("observe: %v", err)
	}
	if obs.ResourceUpToDate {
		t.Fatalf("drift not detected: ResourceUpToDate=true")
	}

	if _, err := e.Update(ctx, cr); err != nil {
		t.Fatalf("update: %v", err)
	}
	if leaseAfter := meta.GetExternalName(cr); leaseAfter != leaseBefore {
		t.Fatalf("update changed the lease: %q -> %q", leaseBefore, leaseAfter)
	}
	if f.minted != 1 {
		t.Fatalf("update minted a new lease: minted=%d", f.minted)
	}

	// Converged: observe now reports up-to-date.
	obs2, err := e.Observe(ctx, cr)
	if err != nil {
		t.Fatalf("observe #2: %v", err)
	}
	if !obs2.ResourceUpToDate {
		t.Fatalf("post-update observe: ResourceUpToDate=false")
	}
}

// TestObserve_LeaseVanished covers a Console-side disappearance: external-name is
// set but GET 404s. Observe must report absent so Crossplane recreates.
func TestObserve_LeaseVanished(t *testing.T) {
	ctx := context.Background()
	f := newFakeConsole()
	e := &external{client: f}

	cr := newMR(nodeID)
	if _, err := e.Create(ctx, cr); err != nil {
		t.Fatalf("create: %v", err)
	}
	// Force the lease closed/gone but keep the external-name on the CR.
	_ = f.Delete(ctx, meta.GetExternalName(cr))

	obs, err := e.Observe(ctx, cr)
	if err != nil {
		t.Fatalf("observe: %v", err)
	}
	if obs.ResourceExists {
		t.Fatalf("observe reported exists for a vanished lease")
	}
}

// TestDelete_Releases proves delete releases the lease, and that a delete on an
// amnesiac object (no external-name) still releases via key adoption.
func TestDelete_Releases(t *testing.T) {
	ctx := context.Background()
	f := newFakeConsole()
	e := &external{client: f}

	cr := newMR(nodeID)
	if _, err := e.Create(ctx, cr); err != nil {
		t.Fatalf("create: %v", err)
	}
	lease := meta.GetExternalName(cr)

	// Delete on an amnesiac object (crash lost the external-name) must still
	// find-and-release by key — no stranded escrow.
	amnesiac := newMR(nodeID)
	if err := e.Delete(ctx, amnesiac); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if dep, found, _ := f.GetByLease(ctx, lease); found {
		t.Fatalf("lease still active after delete: %+v", dep)
	}
}
