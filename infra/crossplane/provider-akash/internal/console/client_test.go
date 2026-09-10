// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

package console

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestHTTPClient_ContractAndAuth exercises the HTTP transport against a stub
// Console: it asserts the Authorization header is forwarded, 404s map to
// found=false (not an error), and the adoption query hits the ?nodeId= seam.
func TestHTTPClient_ContractAndAuth(t *testing.T) {
	var sawAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/compute/deployments":
			_ = json.NewEncoder(w).Encode(Deployment{LeaseID: "1000000", State: "active", PublicHost: "h", Provider: "akash"})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/compute/deployments" && r.URL.Query().Get("nodeId") == "n1":
			_ = json.NewEncoder(w).Encode(findResponse{Deployment: &Deployment{LeaseID: "1000000", State: "active"}})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/compute/deployments" && r.URL.Query().Get("nodeId") == "missing":
			_ = json.NewEncoder(w).Encode(findResponse{Deployment: nil})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/compute/deployments/1000000":
			_ = json.NewEncoder(w).Encode(Deployment{LeaseID: "1000000", State: "active"})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/compute/deployments/gone":
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "not_found"})
		case r.Method == http.MethodDelete:
			_ = json.NewEncoder(w).Encode(map[string]string{"state": "closed"})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := NewHTTP(srv.URL, "Bearer test-token")
	ctx := context.Background()

	dep, err := c.Create(ctx, CreateRequest{NodeID: "n1", Name: "x", PublicHost: "h", Services: []Service{{Name: "app"}}})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if dep.LeaseID != "1000000" {
		t.Fatalf("create lease = %q", dep.LeaseID)
	}
	if sawAuth != "Bearer test-token" {
		t.Fatalf("Authorization header not forwarded: %q", sawAuth)
	}

	if _, found, err := c.FindByKey(ctx, "n1"); err != nil || !found {
		t.Fatalf("FindByKey(n1): found=%v err=%v, want true/nil", found, err)
	}
	if _, found, err := c.FindByKey(ctx, "missing"); err != nil || found {
		t.Fatalf("FindByKey(missing): found=%v err=%v, want false/nil", found, err)
	}

	if _, found, err := c.GetByLease(ctx, "1000000"); err != nil || !found {
		t.Fatalf("GetByLease(1000000): found=%v err=%v", found, err)
	}
	if _, found, err := c.GetByLease(ctx, "gone"); err != nil || found {
		t.Fatalf("GetByLease(gone): found=%v err=%v, want false/nil (404 is not an error)", found, err)
	}

	if err := c.Delete(ctx, "1000000"); err != nil {
		t.Fatalf("delete: %v", err)
	}
}
