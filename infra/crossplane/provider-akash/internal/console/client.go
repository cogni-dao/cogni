// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// Package console is a thin client for the Akash Console API surface the
// provider drives directly. It is intentionally small: the crash-safe reconcile
// logic lives in the ExternalClient (internal/controller/akashdeployment); this
// package is only transport + shapes.
//
// The REST contract mirrors the operator's port-level ProvisionSpec ->
// ProvisionOutput contract (the exact shapes ComputeResourcePort already uses):
//
//	POST   /api/v1/compute/deployments             provision (idempotent on nodeId)
//	GET    /api/v1/compute/deployments?nodeId=<k>  ADOPTION: find active by key
//	GET    /api/v1/compute/deployments/<leaseId>   observe one
//	PUT    /api/v1/compute/deployments/<leaseId>   update in place (same lease)
//	DELETE /api/v1/compute/deployments/<leaseId>   release (idempotent)
package console

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Service is one workload container, matching the MR ServiceSpec shape.
type Service struct {
	Name       string  `json:"name"`
	Image      string  `json:"image"`
	CPUUnits   float64 `json:"cpuUnits"`
	MemoryMi   int     `json:"memoryMi"`
	StorageMi  int     `json:"storageMi"`
	Port       int     `json:"port"`
	Visibility string  `json:"visibility"`
}

// Deployment is the Console's view of a deployment (ProvisionOutput + echoed
// desired state used for drift detection).
type Deployment struct {
	Provider   string    `json:"provider"`
	LeaseID    string    `json:"leaseId"`
	NodeID     string    `json:"nodeId"`
	Name       string    `json:"name"`
	PublicHost string    `json:"publicHost"`
	Services   []Service `json:"services"`
	State      string    `json:"state"`
	Endpoints  []string  `json:"endpoints"`
}

// CreateRequest is the provision/update body. NodeID is the deterministic
// adoption key.
type CreateRequest struct {
	NodeID     string    `json:"nodeId"`
	Name       string    `json:"name"`
	PublicHost string    `json:"publicHost"`
	Services   []Service `json:"services"`
}

// Client is the transport-level Console seam the ExternalClient depends on.
// It is an interface so the reconcile logic is unit-testable against a fake.
type Client interface {
	// GetByLease observes a single deployment by its lease id. found=false on 404.
	GetByLease(ctx context.Context, leaseID string) (dep *Deployment, found bool, err error)

	// FindByKey lists deployments by the deterministic key (nodeId) and returns
	// the single active one, if any. This is the ADOPTION seam: it lets Observe
	// recover a deployment whose lease id (external-name) was never persisted
	// after a crash. found=false when no active deployment exists for the key.
	FindByKey(ctx context.Context, key string) (dep *Deployment, found bool, err error)

	// Create provisions a deployment. The server is idempotent on NodeID, so a
	// re-issued create after a lost external-name write returns the SAME lease.
	Create(ctx context.Context, req CreateRequest) (*Deployment, error)

	// Update mutates an existing deployment in place; the lease id is unchanged.
	Update(ctx context.Context, leaseID string, req CreateRequest) (*Deployment, error)

	// Delete releases a deployment. It is idempotent (a closed/unknown lease
	// still succeeds).
	Delete(ctx context.Context, leaseID string) error
}

// HTTPClient is the production Console client.
type HTTPClient struct {
	baseURL string
	// auth is the full Authorization header value (e.g. "Bearer <token>"),
	// sourced from a k8s Secret via the ProviderConfig — never from git.
	auth string
	hc   *http.Client
}

// NewHTTP builds a Console HTTP client. baseURL is the Console API root; auth is
// the Authorization header value read from the ProviderConfig credentials Secret.
func NewHTTP(baseURL, auth string) *HTTPClient {
	return &HTTPClient{
		baseURL: baseURL,
		auth:    auth,
		hc:      &http.Client{Timeout: 30 * time.Second},
	}
}

var _ Client = (*HTTPClient)(nil)

func (c *HTTPClient) deploymentsURL() string {
	return c.baseURL + "/api/v1/compute/deployments"
}

func (c *HTTPClient) do(ctx context.Context, method, u string, body any) (int, []byte, error) {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, nil, fmt.Errorf("marshal request: %w", err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rdr)
	if err != nil {
		return 0, nil, err
	}
	if c.auth != "" {
		req.Header.Set("Authorization", c.auth)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, data, nil
}

// GetByLease implements Client.
func (c *HTTPClient) GetByLease(ctx context.Context, leaseID string) (*Deployment, bool, error) {
	u := c.deploymentsURL() + "/" + url.PathEscape(leaseID)
	status, data, err := c.do(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, false, err
	}
	switch status {
	case http.StatusOK:
		var dep Deployment
		if err := json.Unmarshal(data, &dep); err != nil {
			return nil, false, fmt.Errorf("decode deployment: %w", err)
		}
		return &dep, true, nil
	case http.StatusNotFound:
		return nil, false, nil
	default:
		return nil, false, fmt.Errorf("GET %s: unexpected status %d: %s", u, status, string(data))
	}
}

// findResponse is the list-by-key shape: {deployment: Deployment|null}.
type findResponse struct {
	Deployment *Deployment `json:"deployment"`
}

// FindByKey implements Client.
func (c *HTTPClient) FindByKey(ctx context.Context, key string) (*Deployment, bool, error) {
	u := c.deploymentsURL() + "?nodeId=" + url.QueryEscape(key)
	status, data, err := c.do(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, false, err
	}
	switch status {
	case http.StatusOK:
		var fr findResponse
		if err := json.Unmarshal(data, &fr); err != nil {
			return nil, false, fmt.Errorf("decode find response: %w", err)
		}
		if fr.Deployment == nil || fr.Deployment.LeaseID == "" {
			return nil, false, nil
		}
		return fr.Deployment, true, nil
	case http.StatusNotFound:
		return nil, false, nil
	default:
		return nil, false, fmt.Errorf("GET %s: unexpected status %d: %s", u, status, string(data))
	}
}

// Create implements Client.
func (c *HTTPClient) Create(ctx context.Context, req CreateRequest) (*Deployment, error) {
	status, data, err := c.do(ctx, http.MethodPost, c.deploymentsURL(), req)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK && status != http.StatusCreated {
		return nil, fmt.Errorf("POST deployments: unexpected status %d: %s", status, string(data))
	}
	var dep Deployment
	if err := json.Unmarshal(data, &dep); err != nil {
		return nil, fmt.Errorf("decode create response: %w", err)
	}
	if dep.LeaseID == "" {
		return nil, fmt.Errorf("POST deployments: response carried no leaseId")
	}
	return &dep, nil
}

// Update implements Client.
func (c *HTTPClient) Update(ctx context.Context, leaseID string, req CreateRequest) (*Deployment, error) {
	u := c.deploymentsURL() + "/" + url.PathEscape(leaseID)
	status, data, err := c.do(ctx, http.MethodPut, u, req)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("PUT %s: unexpected status %d: %s", u, status, string(data))
	}
	var dep Deployment
	if err := json.Unmarshal(data, &dep); err != nil {
		return nil, fmt.Errorf("decode update response: %w", err)
	}
	return &dep, nil
}

// Delete implements Client.
func (c *HTTPClient) Delete(ctx context.Context, leaseID string) error {
	u := c.deploymentsURL() + "/" + url.PathEscape(leaseID)
	status, data, err := c.do(ctx, http.MethodDelete, u, nil)
	if err != nil {
		return err
	}
	// Idempotent release: 200 or 404 both mean "gone".
	if status != http.StatusOK && status != http.StatusNotFound {
		return fmt.Errorf("DELETE %s: unexpected status %d: %s", u, status, string(data))
	}
	return nil
}
