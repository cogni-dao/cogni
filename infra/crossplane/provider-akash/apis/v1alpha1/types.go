// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// Package v1alpha1 contains the API types for provider-akash: the AkashDeployment
// managed resource and the ProviderConfig that carries Akash Console credentials.
package v1alpha1

import (
	xpv1 "github.com/crossplane/crossplane-runtime/apis/common/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// +kubebuilder:object:root=true

// A ProviderConfig configures the Akash provider: it says where to read the
// Akash Console API base URL and the bearer credential (from a k8s Secret).
//
// +kubebuilder:resource:scope=Cluster,categories={crossplane,provider,akash}
// +kubebuilder:printcolumn:name="AGE",type="date",JSONPath=".metadata.creationTimestamp"
// +kubebuilder:subresource:status
type ProviderConfig struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   ProviderConfigSpec   `json:"spec"`
	Status ProviderConfigStatus `json:"status,omitempty"`
}

// ProviderConfigSpec configures an Akash Console provider.
type ProviderConfigSpec struct {
	// Console is the base URL of the Akash Console API (e.g.
	// https://console-api.akash.network). The provider talks to this directly;
	// the operator compute controller is NOT in the reconcile path.
	Console string `json:"console"`

	// Credentials required to authenticate to the Akash Console API. The
	// credential value is NEVER stored in git: it is read from a k8s Secret.
	Credentials ProviderCredentials `json:"credentials"`
}

// ProviderCredentials required to authenticate against the Akash Console API.
type ProviderCredentials struct {
	// Source of the provider credentials. Only "Secret" is supported.
	// +kubebuilder:validation:Enum=Secret
	Source xpv1.CredentialsSource `json:"source"`

	// A reference to a Secret key that contains the full Authorization header
	// value (e.g. "Bearer <token>") sent to the Console API.
	xpv1.CommonCredentialSelectors `json:",inline"`
}

// ProviderConfigStatus reflects the observed state of a ProviderConfig.
type ProviderConfigStatus struct {
	xpv1.ProviderConfigStatus `json:",inline"`
}

// +kubebuilder:object:root=true

// ProviderConfigList contains a list of ProviderConfig.
type ProviderConfigList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []ProviderConfig `json:"items"`
}

// +kubebuilder:object:root=true

// A ProviderConfigUsage indicates that a resource is using a ProviderConfig.
//
// +kubebuilder:resource:scope=Cluster,categories={crossplane,provider,akash}
// +kubebuilder:printcolumn:name="CONFIG-NAME",type="string",JSONPath=".providerConfigRef.name"
// +kubebuilder:printcolumn:name="RESOURCE-KIND",type="string",JSONPath=".resourceRef.kind"
// +kubebuilder:printcolumn:name="RESOURCE-NAME",type="string",JSONPath=".resourceRef.name"
type ProviderConfigUsage struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	xpv1.ProviderConfigUsage `json:",inline"`
}

// +kubebuilder:object:root=true

// ProviderConfigUsageList contains a list of ProviderConfigUsage.
type ProviderConfigUsageList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []ProviderConfigUsage `json:"items"`
}

// ---------------------------------------------------------------------------
// AkashDeployment managed resource
// ---------------------------------------------------------------------------

// A ServiceSpec is one container-shaped workload service. Field names mirror the
// operator's DeclaredProvisionServiceSpec so a repo-spec workload maps 1:1.
type ServiceSpec struct {
	// Name of the service within the deployment.
	Name string `json:"name"`

	// Image is a fully-qualified OCI reference (digest-pinned in production).
	Image string `json:"image"`

	// CPUUnits requested (fractional cores allowed, e.g. 0.5).
	CPUUnits float64 `json:"cpuUnits"`

	// MemoryMi requested, in mebibytes.
	MemoryMi int `json:"memoryMi"`

	// StorageMi requested, in mebibytes.
	StorageMi int `json:"storageMi"`

	// Port the service listens on.
	Port int `json:"port"`

	// Visibility is whether the service is exposed publicly.
	// +kubebuilder:validation:Enum=public;private
	Visibility string `json:"visibility"`
}

// AkashDeploymentParameters are the desired-state inputs for an Akash deployment.
type AkashDeploymentParameters struct {
	// NodeID is the stable logical workload identity (a uuid in the operator's
	// CRD). It is the DETERMINISTIC ADOPTION KEY: the provider dedupes creates
	// and adopts an existing on-chain deployment by this key, so a crash between
	// broadcast and external-name persist can never double-spend escrow.
	// +kubebuilder:validation:MinLength=1
	NodeID string `json:"nodeId"`

	// PublicHost is the hostname the public service is served on.
	// +kubebuilder:validation:MinLength=1
	PublicHost string `json:"publicHost"`

	// Services declares the workload's containers. At least one is required.
	// +kubebuilder:validation:MinItems=1
	Services []ServiceSpec `json:"services"`
}

// AkashDeploymentObservation is the observed state of an Akash deployment.
type AkashDeploymentObservation struct {
	// LeaseID is the opaque on-chain lease handle (the dseq). It is also the
	// Crossplane external-name of this resource, captured eagerly on create and
	// re-derivable by adoption.
	LeaseID string `json:"leaseId,omitempty"`

	// State is the deployment lifecycle state as reported by the Console.
	State string `json:"state,omitempty"`

	// Endpoints are the resolved public endpoints of the deployment.
	Endpoints []string `json:"endpoints,omitempty"`
}

// A AkashDeploymentSpec defines the desired state of an AkashDeployment.
type AkashDeploymentSpec struct {
	xpv1.ResourceSpec `json:",inline"`
	ForProvider       AkashDeploymentParameters `json:"forProvider"`
}

// A AkashDeploymentStatus represents the observed state of an AkashDeployment.
type AkashDeploymentStatus struct {
	xpv1.ResourceStatus `json:",inline"`
	AtProvider          AkashDeploymentObservation `json:"atProvider,omitempty"`
}

// +kubebuilder:object:root=true

// An AkashDeployment is a managed resource that represents a single deployment
// on the Akash network, reconciled directly against the Akash Console API.
//
// +kubebuilder:printcolumn:name="READY",type="string",JSONPath=".status.conditions[?(@.type=='Ready')].status"
// +kubebuilder:printcolumn:name="SYNCED",type="string",JSONPath=".status.conditions[?(@.type=='Synced')].status"
// +kubebuilder:printcolumn:name="LEASE",type="string",JSONPath=".status.atProvider.leaseId"
// +kubebuilder:printcolumn:name="STATE",type="string",JSONPath=".status.atProvider.state"
// +kubebuilder:printcolumn:name="AGE",type="date",JSONPath=".metadata.creationTimestamp"
// +kubebuilder:resource:scope=Cluster,categories={crossplane,managed,akash}
// +kubebuilder:subresource:status
type AkashDeployment struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   AkashDeploymentSpec   `json:"spec"`
	Status AkashDeploymentStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// AkashDeploymentList contains a list of AkashDeployment.
type AkashDeploymentList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []AkashDeployment `json:"items"`
}
