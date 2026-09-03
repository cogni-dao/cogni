// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

package v1alpha1

import (
	xpv1 "github.com/crossplane/crossplane-runtime/apis/common/v1"
	"github.com/crossplane/crossplane-runtime/pkg/resource"
)

// ---------------------------------------------------------------------------
// AkashDeployment: resource.Managed methodset (hand-written; equivalent to what
// crossplane-tools/angryjet would generate).
// ---------------------------------------------------------------------------

// GetCondition of this AkashDeployment.
func (mg *AkashDeployment) GetCondition(ct xpv1.ConditionType) xpv1.Condition {
	return mg.Status.GetCondition(ct)
}

// SetConditions of this AkashDeployment.
func (mg *AkashDeployment) SetConditions(c ...xpv1.Condition) {
	mg.Status.SetConditions(c...)
}

// GetProviderConfigReference of this AkashDeployment.
func (mg *AkashDeployment) GetProviderConfigReference() *xpv1.Reference {
	return mg.Spec.ProviderConfigReference
}

// SetProviderConfigReference of this AkashDeployment.
func (mg *AkashDeployment) SetProviderConfigReference(r *xpv1.Reference) {
	mg.Spec.ProviderConfigReference = r
}

// GetWriteConnectionSecretToReference of this AkashDeployment.
func (mg *AkashDeployment) GetWriteConnectionSecretToReference() *xpv1.SecretReference {
	return mg.Spec.WriteConnectionSecretToReference
}

// SetWriteConnectionSecretToReference of this AkashDeployment.
func (mg *AkashDeployment) SetWriteConnectionSecretToReference(r *xpv1.SecretReference) {
	mg.Spec.WriteConnectionSecretToReference = r
}

// GetPublishConnectionDetailsTo of this AkashDeployment.
func (mg *AkashDeployment) GetPublishConnectionDetailsTo() *xpv1.PublishConnectionDetailsTo {
	return mg.Spec.PublishConnectionDetailsTo
}

// SetPublishConnectionDetailsTo of this AkashDeployment.
func (mg *AkashDeployment) SetPublishConnectionDetailsTo(r *xpv1.PublishConnectionDetailsTo) {
	mg.Spec.PublishConnectionDetailsTo = r
}

// GetManagementPolicies of this AkashDeployment.
func (mg *AkashDeployment) GetManagementPolicies() xpv1.ManagementPolicies {
	return mg.Spec.ManagementPolicies
}

// SetManagementPolicies of this AkashDeployment.
func (mg *AkashDeployment) SetManagementPolicies(p xpv1.ManagementPolicies) {
	mg.Spec.ManagementPolicies = p
}

// GetDeletionPolicy of this AkashDeployment.
func (mg *AkashDeployment) GetDeletionPolicy() xpv1.DeletionPolicy {
	return mg.Spec.DeletionPolicy
}

// SetDeletionPolicy of this AkashDeployment.
func (mg *AkashDeployment) SetDeletionPolicy(p xpv1.DeletionPolicy) {
	mg.Spec.DeletionPolicy = p
}

// GetItems of this AkashDeploymentList.
func (l *AkashDeploymentList) GetItems() []resource.Managed {
	items := make([]resource.Managed, len(l.Items))
	for i := range l.Items {
		items[i] = &l.Items[i]
	}
	return items
}

// ---------------------------------------------------------------------------
// ProviderConfig: resource.ProviderConfig methodset.
// ---------------------------------------------------------------------------

// GetCondition of this ProviderConfig.
func (p *ProviderConfig) GetCondition(ct xpv1.ConditionType) xpv1.Condition {
	return p.Status.GetCondition(ct)
}

// SetConditions of this ProviderConfig.
func (p *ProviderConfig) SetConditions(c ...xpv1.Condition) {
	p.Status.SetConditions(c...)
}

// GetUsers of this ProviderConfig.
func (p *ProviderConfig) GetUsers() int64 {
	return p.Status.Users
}

// SetUsers of this ProviderConfig.
func (p *ProviderConfig) SetUsers(i int64) {
	p.Status.Users = i
}

// ---------------------------------------------------------------------------
// ProviderConfigUsage: resource.ProviderConfigUsage methodset.
// ---------------------------------------------------------------------------

// GetProviderConfigReference of this ProviderConfigUsage.
func (p *ProviderConfigUsage) GetProviderConfigReference() xpv1.Reference {
	return p.ProviderConfigUsage.ProviderConfigReference
}

// SetProviderConfigReference of this ProviderConfigUsage.
func (p *ProviderConfigUsage) SetProviderConfigReference(r xpv1.Reference) {
	p.ProviderConfigUsage.ProviderConfigReference = r
}

// GetResourceReference of this ProviderConfigUsage.
func (p *ProviderConfigUsage) GetResourceReference() xpv1.TypedReference {
	return p.ProviderConfigUsage.ResourceReference
}

// SetResourceReference of this ProviderConfigUsage.
func (p *ProviderConfigUsage) SetResourceReference(r xpv1.TypedReference) {
	p.ProviderConfigUsage.ResourceReference = r
}

// GetItems of this ProviderConfigUsageList.
func (l *ProviderConfigUsageList) GetItems() []resource.ProviderConfigUsage {
	items := make([]resource.ProviderConfigUsage, len(l.Items))
	for i := range l.Items {
		items[i] = &l.Items[i]
	}
	return items
}
