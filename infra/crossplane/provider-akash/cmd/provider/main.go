// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// Command provider is the entrypoint for the Akash Crossplane provider. It is a
// standard crossplane-runtime controller manager: it reconciles AkashDeployment
// managed resources directly against the Akash Console API.
package main

import (
	"os"

	"github.com/crossplane/crossplane-runtime/pkg/logging"
	"github.com/crossplane/crossplane-runtime/pkg/ratelimiter"
	"gopkg.in/alecthomas/kingpin.v2"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"

	"github.com/cogni-dao/provider-akash/apis/v1alpha1"
	"github.com/cogni-dao/provider-akash/internal/controller"
)

func main() {
	var (
		app          = kingpin.New("provider-akash", "A Crossplane provider that reconciles Akash deployments directly against the Console API.").DefaultEnvars()
		debug        = app.Flag("debug", "Run with debug logging.").Short('d').Bool()
		syncInterval = app.Flag("sync", "Controller manager sync period, e.g. 1h.").Short('s').Default("1h").Duration()
		pollInterval = app.Flag("poll", "How often to poll external resources for drift.").Default("1m").Duration()
		leaderElect  = app.Flag("leader-election", "Use leader election for the controller manager.").Short('l').Default("false").OverrideDefaultFromEnvar("LEADER_ELECTION").Bool()
	)
	kingpin.MustParse(app.Parse(os.Args[1:]))

	zl := zap.New(zap.UseDevMode(*debug))
	log := logging.NewLogrLogger(zl.WithName("provider-akash"))
	ctrl.SetLogger(zl)

	cfg, err := ctrl.GetConfig()
	kingpin.FatalIfError(err, "cannot get API server rest config")

	syncPeriod := *syncInterval
	mgr, err := ctrl.NewManager(ratelimiter.LimitRESTConfig(cfg, 10), ctrl.Options{
		LeaderElection:   *leaderElect,
		LeaderElectionID: "crossplane-leader-election-provider-akash",
		Cache:            cache.Options{SyncPeriod: &syncPeriod},
	})
	kingpin.FatalIfError(err, "cannot create controller manager")

	kingpin.FatalIfError(v1alpha1.SchemeBuilder.AddToScheme(mgr.GetScheme()), "cannot add Akash APIs to scheme")
	kingpin.FatalIfError(controller.Setup(mgr, log, *pollInterval), "cannot set up controllers")
	kingpin.FatalIfError(mgr.Start(ctrl.SetupSignalHandler()), "cannot start controller manager")
}
