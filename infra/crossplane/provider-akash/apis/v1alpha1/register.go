// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

package v1alpha1

import (
	"reflect"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"
)

// Package-level metadata.
const (
	Group   = "akash.crossplane.io"
	Version = "v1alpha1"
)

var (
	// SchemeGroupVersion is the group version used to register these objects.
	SchemeGroupVersion = schema.GroupVersion{Group: Group, Version: Version}

	// SchemeBuilder is used to add go types to the GroupVersionKind scheme.
	SchemeBuilder = &scheme.Builder{GroupVersion: SchemeGroupVersion}
)

// AkashDeployment type metadata.
var (
	AkashDeploymentKind             = reflect.TypeOf(AkashDeployment{}).Name()
	AkashDeploymentGroupKind        = schema.GroupKind{Group: Group, Kind: AkashDeploymentKind}.String()
	AkashDeploymentKindAPIVersion   = AkashDeploymentKind + "." + SchemeGroupVersion.String()
	AkashDeploymentGroupVersionKind = SchemeGroupVersion.WithKind(AkashDeploymentKind)
)

// ProviderConfig type metadata.
var (
	ProviderConfigKind             = reflect.TypeOf(ProviderConfig{}).Name()
	ProviderConfigGroupVersionKind = SchemeGroupVersion.WithKind(ProviderConfigKind)

	ProviderConfigUsageKind             = reflect.TypeOf(ProviderConfigUsage{}).Name()
	ProviderConfigUsageGroupVersionKind = SchemeGroupVersion.WithKind(ProviderConfigUsageKind)
)

func init() {
	SchemeBuilder.Register(&AkashDeployment{}, &AkashDeploymentList{})
	SchemeBuilder.Register(&ProviderConfig{}, &ProviderConfigList{})
	SchemeBuilder.Register(&ProviderConfigUsage{}, &ProviderConfigUsageList{})
}

// Ensure the generated deepcopy objects satisfy metav1 typing expectations.
var _ metav1.Object = &AkashDeployment{}
