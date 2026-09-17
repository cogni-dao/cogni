// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-registry/crossplane-control-plane`
 * Purpose: CROSSPLANE_IS_INSTALLED_PER_ENVIRONMENT — the ONE enumeration of the deploy
 *   environments whose Argo control plane actually installs Crossplane (core chart, pinned
 *   packages, the `XComputeWorkload` XRD + Composition, and the credential-free
 *   ClusterProviderConfig). task.5097 added production; task.5129 completes preview.
 * Scope: A static fact about the deploy substrate, expressed as data. No I/O, no env read, no
 *   cluster contact — the fact is asserted against git by `tests/ci-invariants/
 *   crossplane-dormant-substrate.spec.ts`, which fails CI the moment this list and the
 *   installed reality disagree in either direction.
 * Invariants:
 *   - AUTHORITY_REQUIRES_AN_INSTALLED_API: naming `crossplane` for an environment that has no
 *     control plane renders an `XComputeWorkload` into a namespace where that CRD does not
 *     exist. The workload is then reconciled by NOBODY and the node never comes up.
 *   - NO_SILENT_DOWNGRADE: consumers must FAIL rather than degrade such a row to `legacy`. The
 *     two authorities mint Akash leases under deliberately disjoint idempotence keys
 *     (`<ns>:<name>:<uid>:<gen>:<op>:<ord>` vs `xcw:<ns>:<name>:<epoch>`), so a quiet fallback
 *     buys a SECOND PAID LEASE instead of colliding safely.
 *   - INSTALLED_IS_NOT_FUNDED: an installed control plane can RECONCILE a composite; only an
 *     actuator WRITER can PAY for one. They are separate facts with separate constants, because
 *     widening the first without the second is exactly the inert staging task.5097 wanted and
 *     conflating them would have flipped every new node's birth row on merge.
 *   - ACCOUNT_TO_WRITER_IS_INJECTIVE, WRITER_TO_ENVS_IS_NOT (bug.5187): the funding fact is a
 *     `writerFor(env) -> cluster/writer` MAP, not a set of environments. One Console account may
 *     back at most one writer — two writers on one account are two independent ledgers against
 *     one escrow — but one writer may legitimately mint for many environments, which is exactly
 *     what the north star (one production account bills every node in every environment)
 *     requires. Stating this as "account -> at most one environment" was a proxy that has since
 *     become a prohibition on the target design.
 * Why shared, not `@features/compute`: both the catalog policy resolver (features) and the
 *   node-formation catalog generator (`@shared/node-app-scaffold/gens/catalog`) must agree on
 *   this set, and `shared` may not import `features` (.dependency-cruiser.cjs `not-in-allowed`).
 *   Same shape as `NODE_DEPLOYMENT_PROVIDERS` in `./placement`, for the same reason.
 * Side-effects: none (pure)
 * Links: infra/k8s/argocd/control-plane/{candidate-a,preview,production}/,
 *   infra/crossplane/xcomputeworkload/, infra/k8s/overlays/<env>/operator/kustomization.yaml,
 *   src/features/compute/node-compute-api.ts, tests/ci-invariants/crossplane-dormant-substrate.spec.ts,
 *   infra/k8s/overlays/<env>/operator/akash-tx-actuator-external-secret.yaml,
 *   src/features/compute/akash-tx/akash-tx-wallet.ts,
 *   task.5096, task.5097, task.5104, task.5129, story.5016, bug.5187
 * @public
 */

/**
 * Environments carrying a Crossplane control plane — i.e. where `XComputeWorkload` is an
 * INSTALLED API that something will reconcile.
 *
 * task.5094/task.5096 installed it on candidate-a alone (CANDIDATE_FIRST); task.5097 staged the
 * same three Applications for production, and task.5129 completes preview. Adding an environment
 * here without also
 * committing its
 * `infra/k8s/argocd/control-plane/<env>/crossplane-xcomputeworkload-application.yaml`
 * turns CI red, and so does the reverse.
 *
 * WIDENING THIS LIST ACTIVATES NOTHING. It states where a composite COULD be reconciled, not
 * where one IS: the selector is the per-row `compute_api.<env>` cell in `infra/catalog/*.yaml`,
 * and `resolveNodeComputeApi` resolves an absent cell to `legacy` (LEGACY_IS_DEFAULT). Every
 * fleet row omits the cell, so every fleet row is untouched by this constant's value.
 */
export const CROSSPLANE_CONTROL_PLANE_ENVS = [
  "candidate-a",
  "preview",
  "production",
] as const;

export type CrossplaneControlPlaneEnv =
  (typeof CROSSPLANE_CONTROL_PLANE_ENVS)[number];

/**
 * ONE actuator WRITER — the reviewed `writerFor(env) -> cluster/writer` map.
 *
 * WHY A WRITER AND NOT AN ENVIRONMENT (bug.5187). The property that keeps money safe is
 * `account -> at most one WRITER`, because the serializer
 * (`akash_tx_allocations_single_writer_idx`) is a per-database partial unique index: two writers
 * on one Console account with two Postgres ledgers cannot see each other, so a retry can pay
 * twice. `account -> at most one ENVIRONMENT` was a usable PROXY only while every writer served
 * exactly its own environment. It is not the property, and under the north star — one production
 * account bills every real node in EVERY environment — it actively forbids the target design.
 *
 * So the mapping is stated explicitly, with the two halves kept apart:
 *   - `writer -> envs` is DELIBERATELY ONE-TO-MANY. A lease is minted off-cluster against
 *     `console-api.akash.network`, so the writer's cluster is independent of where the workload
 *     runs, and one writer may legitimately mint for test, preview and production alike.
 *   - `account -> writer` must stay INJECTIVE. Two writers reaching one account is the
 *     double-spend shape, whichever environments they serve.
 *
 * `cluster` is the environment whose cluster runs the writer Deployment, and therefore the
 * environment whose overlay pins the account and whose ExternalSecret carries the Console key.
 * `serves` is the set of environments whose leases it mints. Today each writer serves only its
 * own cluster — widening a `serves` list IS the north-star cutover, and it is a reviewed edit
 * here rather than an emergent consequence of an overlay change.
 *
 * `tests/ci-invariants/crossplane-dormant-substrate.spec.ts` asserts every half of this against
 * git: one account per writer, one Console-key remoteRef per account, and exactly one writer for
 * every environment whose catalog rows select `compute_api: crossplane`.
 */
export interface CrossplaneActuatorWriter {
  /** Stable identity of the actuator Deployment: `<cluster>/akash-tx-actuator`. */
  readonly id: string;
  /** The environment whose cluster runs this writer, pins its account and holds its key. */
  readonly cluster: string;
  /** Environments whose leases this writer mints. One-to-many BY DESIGN. */
  readonly serves: readonly string[];
  /**
   * GitHub OWNER ORGS whose nodes this writer mints for (bug.5202).
   *
   * Serving used to be keyed on the environment ALONE, which cannot express the north star:
   * `akash-actuator-wallet-cutover` NS3 says every REAL node bills the production account in
   * EVERY environment, while NS4 says the test account pays ONLY for the operator's own
   * self-test on `cogni-test-org` throwaway nodes. Both claim the env name `candidate-a`, so
   * one writer per env made `writerFor("candidate-a")` either ambiguous (undefined — breaking
   * candidate-a) or wrong (a real node billing the test account). The doc rules on who PAYS,
   * which is a function of the node's OWNER; the code modelled who SERVES, a function of the
   * env. Keying on the pair makes both rulings expressible at once.
   */
  readonly owners: readonly string[];
}

export const CROSSPLANE_ACTUATOR_WRITERS: readonly CrossplaneActuatorWriter[] =
  [
    {
      id: "candidate-a/akash-tx-actuator",
      cluster: "candidate-a",
      // NS4: this account exists ONLY to test the operator platform itself. It never pays
      // for a real node, so it serves exactly one org and one lane.
      serves: ["candidate-a"],
      owners: ["cogni-test-org"],
    },
    {
      id: "production/akash-tx-actuator",
      cluster: "production",
      // NS3: every REAL node deployment, in EVERY environment, bills the production Console
      // account. Environment is a property of the deployment, not of who pays — one org, one
      // bill (the Vercel shape the north star names). Preview and candidate-a pin no account
      // of their own, so before this they had no writer for real nodes at all and every
      // placement failed closed with `actuator_account_id_missing`.
      //
      // The bug.5187 injectivity restatement holds: `account -> writer` stays INJECTIVE (one
      // writer on this account ⇒ one ledger against one escrow), while `writer -> envs` is
      // deliberately one-to-many. CROSSPLANE_ACTUATOR_WALLET_ENVS derives from `cluster`, NOT
      // `serves`, so preview and candidate-a still host no writer and hold no Console key —
      // widening `serves` is a PAYMENT fact, not a claim about where keys live.
      serves: ["candidate-a", "preview", "production"],
      owners: ["cogni-dao"],
    },
  ] as const;

/**
 * Which writer mints `environment`'s leases, if any? The NS3 reading of "may this environment
 * actuate": not "does this environment pin an account" (an environment served by another
 * cluster's writer pins nothing) but "is there exactly one writer that serves it".
 */
export function writerFor(
  environment: string,
  ownerOrg: string
): CrossplaneActuatorWriter | undefined {
  const writers = CROSSPLANE_ACTUATOR_WRITERS.filter(
    (writer) =>
      writer.serves.includes(environment) &&
      writer.owners.includes(ownerOrg.toLowerCase())
  );
  return writers.length === 1 ? writers[0] : undefined;
}

/**
 * Environments that RUN an actuator writer — i.e. whose operator overlay pins a non-empty
 * `AKASH_ACTUATOR_ACCOUNT_ID` on the `akash-tx-actuator` Deployment and whose ExternalSecret
 * carries that account's Console key. Derived from {@link CROSSPLANE_ACTUATOR_WRITERS} so the
 * two cannot drift, and asserted against git in both directions by
 * `tests/ci-invariants/crossplane-dormant-substrate.spec.ts`.
 *
 * READ THE NAME CAREFULLY: this is "the cluster that HOSTS a writer", not "the environment whose
 * leases are paid for". Those were the same set until bug.5187 and are not the same question —
 * use {@link writerFor} for the second. Preview hosts no writer: it installs the composite API
 * but pins NO account (INSTALLED_IS_NOT_FUNDED), which is why widening this list is a funding
 * decision while widening {@link CROSSPLANE_CONTROL_PLANE_ENVS} is not.
 */
export const CROSSPLANE_ACTUATOR_WALLET_ENVS: readonly string[] =
  CROSSPLANE_ACTUATOR_WRITERS.map((writer) => writer.cluster);

/**
 * The Argo Application that installs the `XComputeWorkload` composite API in `environment`.
 * Named in error messages so a failure states the exact file that has to exist.
 */
export function crossplaneCompositeApplicationPath(
  environment: string
): string {
  return `infra/k8s/argocd/control-plane/${environment}/crossplane-xcomputeworkload-application.yaml`;
}

/** Does `environment` have a Crossplane control plane to reconcile an `XComputeWorkload`? */
export function hasCrossplaneControlPlane(environment: string): boolean {
  return (CROSSPLANE_CONTROL_PLANE_ENVS as readonly string[]).includes(
    environment
  );
}

/**
 * May a NEWLY BORN node be minted onto the Crossplane authority in `environment`? Requires both
 * facts: an installed composite API to reconcile the workload, AND exactly one actuator writer
 * that mints for it. Staging a control plane therefore does not change what a birth renders.
 *
 * The second fact asks {@link writerFor}, not "does this environment pin an account" (bug.5187).
 * Under the north star an environment can be fully funded by a writer living in another cluster
 * and a birth row must be legal there; conversely an environment two writers both claimed to
 * serve is ambiguous, and `writerFor` returns undefined rather than picking one.
 */
export function canBirthOnCrossplane(
  environment: string,
  ownerOrg: string
): boolean {
  return (
    hasCrossplaneControlPlane(environment) &&
    writerFor(environment, ownerOrg) !== undefined
  );
}
