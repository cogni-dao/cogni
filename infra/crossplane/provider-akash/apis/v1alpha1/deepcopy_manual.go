// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// Hand-written DeepCopy methods for the nested spec/status structs. controller-gen
// skips these because they embed crossplane-runtime types (xpv1.ResourceSpec,
// xpv1.CommonCredentialSelectors, ...) whose promoted DeepCopyInto shadows the
// generated one with a mismatched receiver. Defining them explicitly here fixes
// the signature so the generated root-object DeepCopy compiles.

package v1alpha1

// DeepCopyInto for AkashDeploymentSpec.
func (in *AkashDeploymentSpec) DeepCopyInto(out *AkashDeploymentSpec) {
	*out = *in
	in.ResourceSpec.DeepCopyInto(&out.ResourceSpec)
	in.ForProvider.DeepCopyInto(&out.ForProvider)
}

// DeepCopy for AkashDeploymentSpec.
func (in *AkashDeploymentSpec) DeepCopy() *AkashDeploymentSpec {
	if in == nil {
		return nil
	}
	out := new(AkashDeploymentSpec)
	in.DeepCopyInto(out)
	return out
}

// DeepCopyInto for AkashDeploymentStatus.
func (in *AkashDeploymentStatus) DeepCopyInto(out *AkashDeploymentStatus) {
	*out = *in
	in.ResourceStatus.DeepCopyInto(&out.ResourceStatus)
	in.AtProvider.DeepCopyInto(&out.AtProvider)
}

// DeepCopy for AkashDeploymentStatus.
func (in *AkashDeploymentStatus) DeepCopy() *AkashDeploymentStatus {
	if in == nil {
		return nil
	}
	out := new(AkashDeploymentStatus)
	in.DeepCopyInto(out)
	return out
}

// DeepCopyInto for AkashDeploymentParameters.
func (in *AkashDeploymentParameters) DeepCopyInto(out *AkashDeploymentParameters) {
	*out = *in
	if in.Services != nil {
		out.Services = make([]ServiceSpec, len(in.Services))
		copy(out.Services, in.Services)
	}
}

// DeepCopy for AkashDeploymentParameters.
func (in *AkashDeploymentParameters) DeepCopy() *AkashDeploymentParameters {
	if in == nil {
		return nil
	}
	out := new(AkashDeploymentParameters)
	in.DeepCopyInto(out)
	return out
}

// DeepCopyInto for AkashDeploymentObservation.
func (in *AkashDeploymentObservation) DeepCopyInto(out *AkashDeploymentObservation) {
	*out = *in
	if in.Endpoints != nil {
		out.Endpoints = make([]string, len(in.Endpoints))
		copy(out.Endpoints, in.Endpoints)
	}
}

// DeepCopy for AkashDeploymentObservation.
func (in *AkashDeploymentObservation) DeepCopy() *AkashDeploymentObservation {
	if in == nil {
		return nil
	}
	out := new(AkashDeploymentObservation)
	in.DeepCopyInto(out)
	return out
}

// DeepCopyInto for ServiceSpec (all scalar fields).
func (in *ServiceSpec) DeepCopyInto(out *ServiceSpec) {
	*out = *in
}

// DeepCopy for ServiceSpec.
func (in *ServiceSpec) DeepCopy() *ServiceSpec {
	if in == nil {
		return nil
	}
	out := new(ServiceSpec)
	in.DeepCopyInto(out)
	return out
}

// DeepCopyInto for ProviderConfigSpec.
func (in *ProviderConfigSpec) DeepCopyInto(out *ProviderConfigSpec) {
	*out = *in
	in.Credentials.DeepCopyInto(&out.Credentials)
}

// DeepCopy for ProviderConfigSpec.
func (in *ProviderConfigSpec) DeepCopy() *ProviderConfigSpec {
	if in == nil {
		return nil
	}
	out := new(ProviderConfigSpec)
	in.DeepCopyInto(out)
	return out
}

// DeepCopyInto for ProviderCredentials.
func (in *ProviderCredentials) DeepCopyInto(out *ProviderCredentials) {
	*out = *in
	in.CommonCredentialSelectors.DeepCopyInto(&out.CommonCredentialSelectors)
}

// DeepCopy for ProviderCredentials.
func (in *ProviderCredentials) DeepCopy() *ProviderCredentials {
	if in == nil {
		return nil
	}
	out := new(ProviderCredentials)
	in.DeepCopyInto(out)
	return out
}

// DeepCopyInto for ProviderConfigStatus.
func (in *ProviderConfigStatus) DeepCopyInto(out *ProviderConfigStatus) {
	*out = *in
	in.ProviderConfigStatus.DeepCopyInto(&out.ProviderConfigStatus)
}

// DeepCopy for ProviderConfigStatus.
func (in *ProviderConfigStatus) DeepCopy() *ProviderConfigStatus {
	if in == nil {
		return nil
	}
	out := new(ProviderConfigStatus)
	in.DeepCopyInto(out)
	return out
}
