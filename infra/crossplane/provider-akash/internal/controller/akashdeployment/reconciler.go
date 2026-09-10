// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

package akashdeployment

import (
	"context"
	"strings"
	"time"

	"github.com/crossplane/crossplane-runtime/pkg/errors"
	"github.com/crossplane/crossplane-runtime/pkg/event"
	"github.com/crossplane/crossplane-runtime/pkg/logging"
	"github.com/crossplane/crossplane-runtime/pkg/reconciler/managed"
	"github.com/crossplane/crossplane-runtime/pkg/resource"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/cogni-dao/provider-akash/apis/v1alpha1"
	"github.com/cogni-dao/provider-akash/internal/console"
)

const (
	errNotAkashDeployment = "managed resource is not an AkashDeployment"
	errTrackPCUsage       = "cannot track ProviderConfig usage"
	errGetPC              = "cannot get ProviderConfig"
	errGetCreds           = "cannot get credentials"
)

// clientBuilder constructs a console.Client from a base URL and auth header. It
// is a field so tests can inject a fake without real HTTP.
type clientBuilder func(baseURL, auth string) console.Client

// connector produces an ExternalClient for a given AkashDeployment by resolving
// its ProviderConfig + credential Secret.
type connector struct {
	kube       client.Client
	usage      resource.Tracker
	newConsole clientBuilder
}

// Connect implements managed.ExternalConnecter.
func (c *connector) Connect(ctx context.Context, mg resource.Managed) (managed.ExternalClient, error) {
	cr, ok := mg.(*v1alpha1.AkashDeployment)
	if !ok {
		return nil, errors.New(errNotAkashDeployment)
	}

	if err := c.usage.Track(ctx, mg); err != nil {
		return nil, errors.Wrap(err, errTrackPCUsage)
	}

	pc := &v1alpha1.ProviderConfig{}
	if err := c.kube.Get(ctx, client.ObjectKey{Name: cr.GetProviderConfigReference().Name}, pc); err != nil {
		return nil, errors.Wrap(err, errGetPC)
	}

	creds, err := resource.CommonCredentialExtractor(ctx, pc.Spec.Credentials.Source, c.kube, pc.Spec.Credentials.CommonCredentialSelectors)
	if err != nil {
		return nil, errors.Wrap(err, errGetCreds)
	}

	return &external{client: c.newConsole(pc.Spec.Console, strings.TrimSpace(string(creds)))}, nil
}

// Setup wires the AkashDeployment controller into the manager. Note the empty
// WithInitializers(): we deliberately DO NOT use NameAsExternalName, because an
// empty external-name is the signal that triggers the crash-safe adoption path
// in Observe. The lease id is the external-name, captured on create/adoption.
func Setup(mgr ctrl.Manager, l logging.Logger, pollInterval time.Duration) error {
	name := managed.ControllerName(v1alpha1.AkashDeploymentGroupKind)

	r := managed.NewReconciler(mgr,
		resource.ManagedKind(v1alpha1.AkashDeploymentGroupVersionKind),
		managed.WithExternalConnecter(&connector{
			kube:       mgr.GetClient(),
			usage:      resource.NewProviderConfigUsageTracker(mgr.GetClient(), &v1alpha1.ProviderConfigUsage{}),
			newConsole: func(baseURL, auth string) console.Client { return console.NewHTTP(baseURL, auth) },
		}),
		managed.WithInitializers(),
		managed.WithLogger(l.WithValues("controller", name)),
		managed.WithPollInterval(pollInterval),
		managed.WithRecorder(event.NewAPIRecorder(mgr.GetEventRecorderFor(name))),
	)

	return ctrl.NewControllerManagedBy(mgr).
		Named(name).
		For(&v1alpha1.AkashDeployment{}).
		Complete(r)
}
