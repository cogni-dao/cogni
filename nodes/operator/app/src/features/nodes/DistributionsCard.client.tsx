// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/DistributionsCard.client`
 * Purpose: The ONE-TIME distribution SETUP surface for a node — a single guided sequence the owner
 *   runs once, on the node page. Three ordered steps, one per PLANE, each derived from that plane's
 *   GROUND TRUTH (story.5004 — never optimistic local state, so a refresh re-derives the same view):
 *     1. DEPLOY DISTRIBUTOR (on-chain) — the owner's wallet deploys the vendored
 *        `CumulativeMerkleDistributor(token)` and transfers ownership to the DAO
 *        (useDeployDistributor). Truth: a known distributor address, verified on-chain
 *        (`owner()==DAO`, `token()==token` via useDistributorOnChain).
 *     2. AUTHORIZE PUBLISHING (on-chain) — ONE governance proposal granting the wallet CAS-scoped
 *        EXECUTE via the publish condition. Truth is a paired on-chain permission proof.
 *     3. RECORD ACTIVATION (git) — only after both on-chain planes verify, the operator App opens a
 *        repo-spec PR on the node's own repo
 *        (`distributions.status: active`, `distributor_address`, claim pattern). Truth: the
 *        GET distributions-status route (repo-spec on `main` + open-PR state). The OPEN-PR state is
 *        FIRST-CLASS: "Activation recorded — PR #N open, merge to persist" with a clickable link —
 *        NEVER rendered as baseline while the PR is unmerged (the toks3 revert-to-baseline bug).
 *   Ordering is enforced honestly: deploy → authorize → record. The repo-spec never says active
 *   before CAS publishing authority is verified. State folding is pure + unit-tested
 *   (`distribution-setup-state.ts`).
 * Scope: Renders a "Set up distributions" SectionCard (page-aligned with NodeAccess/Danger zone).
 *   Wallet-gated (wagmi) + chain-gated (node chain) for the on-chain steps. Server props
 *   (distributionsActive, recordedDistributorAddress) are the page's repo-spec read, used as the
 *   fallback when the status route is unavailable (local dev, no App creds).
 * Side-effects: IO (GET distributions-status, POST activate-distributions, router.refresh),
 *   blockchain writes via wallet.
 * Links: src/app/api/v1/nodes/[id]/distributions-status/route.ts,
 *   src/app/api/v1/nodes/[id]/activate-distributions/route.ts,
 *   src/features/nodes/distribution-setup-state.ts, src/features/nodes/useDeployDistributor.ts,
 *   src/features/governance/hooks/useAuthorizePublishing.ts,
 *   src/features/governance/hooks/useExecuteDistribution.ts (useHasExecutePermission),
 *   docs/spec/tokenomics-distribution.md ("Activation — one guided flow, git-authoritative")
 * @public
 */

"use client";

import { getTransactionExplorerUrl } from "@cogni/node-shared";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";

import { Button, SectionCard, WalletConnectButton } from "@/components";
import {
  StepRow,
  type StepState,
} from "@/features/governance/components/LifecycleStepper";
import { useAuthorizePublishing } from "@/features/governance/hooks/useAuthorizePublishing";
import { useHasExecutePermission } from "@/features/governance/hooks/useExecuteDistribution";
import {
  type ActivationPrRef,
  type DistributionSetupDerived,
  deriveDistributionSetup,
  type SetupStepState,
} from "@/features/nodes/distribution-setup-state";
import {
  useDeployDistributor,
  useDistributorOnChain,
} from "@/features/nodes/useDeployDistributor";

interface Props {
  readonly nodeId: string;
  readonly slug: string;
  readonly repoSpecUrl: string | null;
  /** The node's GovernanceERC20 token (constructor arg for the distributor). Null hides deploy. */
  readonly tokenAddress: string | null;
  /** The DAO that receives distributor ownership + grants publish authority. Null hides on-chain steps. */
  readonly daoAddress: string | null;
  /** The node's Aragon TokenVoting plugin — createProposal target for the authorize step. */
  readonly pluginAddress: string | null;
  /** The node's chain id — on-chain steps are gated on the connected wallet matching it. */
  readonly chainId: number | null;
  /** Server fallback: `distributions.status: active` in the node repo-spec (page-time read). */
  readonly distributionsActive: boolean;
  /** Server fallback: the distributor address recorded in the spec, if any (page-time read). */
  readonly recordedDistributorAddress: string | null;
}

/** Plane-2 record status served by GET `/api/v1/nodes/[id]/distributions-status`. */
interface DistributionRecordStatus {
  readonly repoSpecActive: boolean;
  readonly mainSha: string | null;
  readonly activationPr: {
    readonly number: number;
    readonly url: string;
    readonly state: "open" | "merged";
  } | null;
  readonly recordedDistributorAddress: string | null;
  readonly pendingDistributorAddress: string | null;
}

/**
 * Read the git-plane record status. Null = unavailable (route unconfigured / node missing token/DAO
 * / network hiccup) — the card then degrades to the page's server-side fallback props.
 */
async function fetchRecordStatus(
  nodeId: string
): Promise<DistributionRecordStatus | null> {
  try {
    const response = await fetch(
      `/api/v1/nodes/${nodeId}/distributions-status`
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      record?: DistributionRecordStatus;
    };
    return body.record ?? null;
  } catch {
    return null;
  }
}

/** POST the activation route; returns the activation result (throws with the server reason on !ok). */
async function postActivateDistributions(
  nodeId: string,
  body: Record<string, unknown>
): Promise<{ status?: string; prUrl?: string } | null> {
  const response = await fetch(
    `/api/v1/nodes/${nodeId}/activate-distributions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // non-JSON body falls through to the raw-text error path below
  }
  if (!response.ok) {
    let reason = `HTTP ${response.status}`;
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "string"
    ) {
      reason = (parsed as { error: string }).error;
    } else if (text.trim() !== "") {
      reason = text;
    }
    throw new Error(reason);
  }
  return parsed && typeof parsed === "object" && "activation" in parsed
    ? (parsed as { activation: { status?: string; prUrl?: string } }).activation
    : null;
}

export function DistributionsCard({
  nodeId,
  slug,
  repoSpecUrl,
  tokenAddress,
  daoAddress,
  pluginAddress,
  chainId,
  distributionsActive,
  recordedDistributorAddress,
}: Props): ReactElement {
  // Plane-2 ground truth, refresh-safe: the record status route (repo-spec main + open-PR state).
  // Polls while an activation PR is open so the merge flips the step live. Null data = unavailable
  // → the sequence falls back to the page's server-side props.
  const recordQuery = useQuery({
    queryKey: ["node-distributions-status", nodeId],
    queryFn: () => fetchRecordStatus(nodeId),
    staleTime: 15_000,
    refetchInterval: (query) =>
      query.state.data?.activationPr?.state === "open" ? 30_000 : false,
  });
  // STABLE identity — children hold this in effect deps; an inline closure would re-fire those
  // effects every render (react-query's refetch itself is stable across renders).
  const { refetch } = recordQuery;
  const refetchRecord = useCallback(() => {
    void refetch();
  }, [refetch]);

  return (
    <SectionCard title="Set up distributions" className="mt-4 w-full">
      <p className="text-muted-foreground text-sm">
        A one-time setup so <span className="font-medium">{slug}</span> can pay
        contributors in its DAO token. After setup, each epoch publishes in a
        single transaction with no vote.
      </p>

      {tokenAddress && daoAddress && chainId != null ? (
        <SetupSequence
          nodeId={nodeId}
          slug={slug}
          repoSpecUrl={repoSpecUrl}
          tokenAddress={tokenAddress as `0x${string}`}
          daoAddress={daoAddress as `0x${string}`}
          pluginAddress={
            pluginAddress ? (pluginAddress as `0x${string}`) : null
          }
          chainId={chainId}
          fallbackDistributionsActive={distributionsActive}
          fallbackRecordedDistributorAddress={
            recordedDistributorAddress
              ? (recordedDistributorAddress as `0x${string}`)
              : null
          }
          record={recordQuery.data ?? null}
          refetchRecord={refetchRecord}
        />
      ) : (
        <p className="mt-2 text-muted-foreground text-sm">
          Complete this node&apos;s DAO and token formation first. Distribution
          setup becomes available when the operator has the node&apos;s DAO,
          token, voting plugin, and chain.
        </p>
      )}
    </SectionCard>
  );
}

/**
 * The three-step guided setup, ordered deploy → authorize → record. Every step state comes from
 * `deriveDistributionSetup` over per-plane ground truth; in-session actions only trigger refetches
 * (status route, on-chain permission, router.refresh) — they never flip a step by themselves.
 */
function SetupSequence({
  nodeId,
  slug,
  repoSpecUrl,
  tokenAddress,
  daoAddress,
  pluginAddress,
  chainId,
  fallbackDistributionsActive,
  fallbackRecordedDistributorAddress,
  record,
  refetchRecord,
}: {
  nodeId: string;
  slug: string;
  repoSpecUrl: string | null;
  tokenAddress: `0x${string}`;
  daoAddress: `0x${string}`;
  pluginAddress: `0x${string}` | null;
  chainId: number;
  fallbackDistributionsActive: boolean;
  fallbackRecordedDistributorAddress: `0x${string}` | null;
  record: DistributionRecordStatus | null;
  refetchRecord: () => void;
}): ReactElement {
  const { address, isConnected } = useAccount();
  const connectedChainId = useChainId();
  const { switchChain } = useSwitchChain();

  // Step 1 driver: deploy → transferOwnership(DAO). This does not activate the node.
  const deploy = useDeployDistributor(tokenAddress, daoAddress);

  // Fallback PR ref for environments where the status route is unavailable.
  const [sessionPrUrl, setSessionPrUrl] = useState<string | null>(null);

  // Fold the per-plane truths. When the status route answered, IT is the record truth; otherwise
  // fall back to the page's server-side read + the in-session PR url.
  const openPr: ActivationPrRef | null = record
    ? record.activationPr?.state === "open"
      ? { number: record.activationPr.number, url: record.activationPr.url }
      : null
    : sessionPrUrl
      ? { number: null, url: sessionPrUrl }
      : null;
  const repoSpecActive = record
    ? record.repoSpecActive
    : fallbackDistributionsActive;
  const recordedAddress = record
    ? record.recordedDistributorAddress
    : fallbackRecordedDistributorAddress;
  const pendingAddress = record?.pendingDistributorAddress ?? null;

  // Best-known distributor (session > main record > open PR) — needed BEFORE the fold so the
  // on-chain permission probe (plane 2 truth) can run against it.
  const knownDistributor = (deploy.distributorAddress ??
    recordedAddress ??
    pendingAddress) as `0x${string}` | null;

  // Plane-2 truth: paired probes prove the wallet holds the current CAS-scoped permission.
  const { hasPermission, refetch: refetchPermission } = useHasExecutePermission(
    {
      daoAddress,
      wallet: address,
      tokenAddress,
      distributorAddress: knownDistributor,
      chainId,
    }
  );

  // Plane-1 truth: verify the known distributor on-chain (owner()==DAO, token()==token).
  const distributorOnChain = useDistributorOnChain({
    distributorAddress: knownDistributor,
    daoAddress,
    tokenAddress,
    chainId,
  });

  const derived = deriveDistributionSetup({
    repoSpecActive,
    openPr,
    recordedDistributorAddress: recordedAddress,
    pendingDistributorAddress: pendingAddress,
    sessionDistributorAddress: deploy.distributorAddress,
    distributorVerified: distributorOnChain.status === "verified",
    authorized: hasPermission === true,
  });

  const onCorrectChain = connectedChainId === chainId;
  const walletReady = isConnected && onCorrectChain;

  return (
    <div className="mt-2 space-y-3">
      {/* Wallet + chain gating is shared by steps 1 and 2. Step 3 is the terminal server write. */}
      {!isConnected ? (
        <div className="rounded-lg border border-border bg-muted/20 p-3">
          <p className="mb-2 text-muted-foreground text-sm">
            Connect the node owner wallet to deploy + authorize.
          </p>
          <WalletConnectButton />
        </div>
      ) : !onCorrectChain ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => switchChain?.({ chainId })}
        >
          Switch network to continue setup
        </Button>
      ) : null}

      <DeployStep
        state={derived.steps.deploy}
        chainId={chainId}
        deploy={deploy}
        derived={derived}
        onChain={distributorOnChain}
        walletReady={walletReady}
      />

      <AuthorizeStep
        state={derived.steps.authorize}
        chainId={chainId}
        tokenAddress={tokenAddress}
        daoAddress={daoAddress}
        pluginAddress={pluginAddress}
        distributorAddress={knownDistributor}
        wallet={address ?? null}
        walletReady={walletReady}
        onAuthorized={refetchPermission}
      />

      <RecordStep
        state={derived.steps.record}
        nodeId={nodeId}
        slug={slug}
        repoSpecUrl={repoSpecUrl}
        derived={derived}
        publisherAddress={address ?? null}
        deployTx={deploy.deployTx}
        onRecorded={(prUrl) => {
          if (prUrl) setSessionPrUrl(prUrl);
          refetchRecord();
        }}
      />

      {derived.currentStep === null ? (
        <p className="text-primary text-sm">
          Distribution setup is complete
          {derived.recordPlane.kind === "pr_open"
            ? " — merge the activation PR above to persist the record."
            : ". Each epoch now publishes in a single transaction with no vote."}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Step 1 — deploy the distributor (on-chain plane). Done when a distributor address is known from
 * ANY plane; the caption says where it came from and what the chain says about it (owner()==DAO).
 */
function DeployStep({
  state,
  chainId,
  deploy,
  derived,
  onChain,
  walletReady,
}: {
  state: SetupStepState;
  chainId: number;
  deploy: ReturnType<typeof useDeployDistributor>;
  derived: DistributionSetupDerived;
  onChain: ReturnType<typeof useDistributorOnChain>;
  walletReady: boolean;
}): ReactElement {
  const { phase, deployTx, transferTx, error, deploy: runDeploy } = deploy;

  const busy = phase === "deploying" || phase === "transferring";
  const deployTxUrl = deployTx
    ? getTransactionExplorerUrl(chainId, deployTx)
    : null;
  const transferTxUrl = transferTx
    ? getTransactionExplorerUrl(chainId, transferTx)
    : null;

  if (state === "done") {
    const sourceLabel =
      derived.distributorSource === "session"
        ? "deployed this session"
        : derived.distributorSource === "repo-spec"
          ? "recorded in the repo-spec"
          : "recorded in the open activation PR";
    return (
      <StepRow n={1} state="done" title="Distributor deployed">
        <p className="break-all font-mono text-muted-foreground text-xs">
          Distributor: {derived.distributorAddress} ({sourceLabel})
        </p>
        {onChain.status === "verified" ? (
          <p className="text-muted-foreground text-sm">
            On-chain: owned by the node DAO, distributes the node token.
          </p>
        ) : onChain.status === "mismatch" ? (
          <p className="text-destructive text-sm">
            On-chain check failed: this distributor is not owned by the node DAO
            (or its token does not match). Redeploy before recording.
          </p>
        ) : null}
      </StepRow>
    );
  }

  const phaseLabel =
    phase === "deploying"
      ? "Deploying distributor… confirm in wallet"
      : phase === "transferring"
        ? "Transferring ownership to the DAO… confirm in wallet"
        : null;

  return (
    <StepRow n={1} state={toStepRowState(state)} title="Deploy distributor">
      {state === "current" ? (
        <>
          <p className="text-muted-foreground text-sm">
            Your wallet deploys the vendored CumulativeMerkleDistributor for
            this node&apos;s token and transfers ownership to the DAO — the DAO
            owns it from then on. The address is then recorded in the
            node&apos;s repo-spec after publishing authorization is verified.
          </p>

          <Button
            type="button"
            onClick={runDeploy}
            disabled={busy || !walletReady}
            className="gap-2"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Deploy distributor
          </Button>
          {!walletReady ? (
            <p className="text-muted-foreground text-sm">
              Connect the owner wallet on the node&apos;s chain to deploy.
            </p>
          ) : null}

          {phaseLabel ? (
            <p className="text-muted-foreground text-sm">{phaseLabel}</p>
          ) : null}
          {deployTxUrl ? (
            <ExternalLinkRow href={deployTxUrl}>
              Deploy transaction
            </ExternalLinkRow>
          ) : null}
          {transferTxUrl ? (
            <ExternalLinkRow href={transferTxUrl}>
              Transfer-ownership transaction
            </ExternalLinkRow>
          ) : null}
          {error ? <p className="text-destructive text-sm">{error}</p> : null}
        </>
      ) : null}
    </StepRow>
  );
}

/**
 * Step 3 — the git-authoritative activation record. Four honest states from plane-2 ground truth:
 *   recorded (merged on main) · pr_open (FIRST-CLASS: "merge to persist" + PR link — never
 *   baseline) · record_incomplete (spec active but the deployed distributor isn't pinned) ·
 *   not_recorded (needs the deploy first, or the record click).
 */
function RecordStep({
  state,
  nodeId,
  slug,
  repoSpecUrl,
  derived,
  publisherAddress,
  deployTx,
  onRecorded,
}: {
  state: SetupStepState;
  nodeId: string;
  slug: string;
  repoSpecUrl: string | null;
  derived: DistributionSetupDerived;
  publisherAddress: `0x${string}` | null;
  deployTx: `0x${string}` | undefined;
  onRecorded: (prUrl: string | null) => void;
}): ReactElement {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleRecord = async () => {
    if (submitting || !derived.distributorAddress || !publisherAddress) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const activation = await postActivateDistributions(nodeId, {
        distributorAddress: derived.distributorAddress,
        publisherAddress,
        ...(deployTx ? { deployTx } : {}),
      });
      onRecorded(
        activation?.status === "pr_opened" && activation.prUrl
          ? activation.prUrl
          : null
      );
      router.refresh();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "recording failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (derived.recordPlane.kind === "recorded") {
    return (
      <StepRow n={3} state="done" title="Activation recorded">
        <p className="text-muted-foreground text-sm">
          The node repo-spec records <code>distributions.status: active</code>
          {derived.distributorAddress ? " and the distributor address" : ""}.
        </p>
        {repoSpecUrl ? (
          <ExternalLinkRow href={repoSpecUrl}>View repo-spec</ExternalLinkRow>
        ) : null}
      </StepRow>
    );
  }

  if (derived.recordPlane.kind === "pr_open") {
    const pr = derived.recordPlane.pr;
    return (
      <StepRow
        n={3}
        state="awaiting"
        title="Activation recorded — merge to persist"
      >
        <p className="text-muted-foreground text-sm">
          The activation record is an open pull request on{" "}
          <span className="font-medium">{slug}</span>
          {pr.number != null ? ` (PR #${pr.number})` : ""} — it persists once
          merged. Until then this page reads the open PR, so nothing is lost on
          refresh.
        </p>
        <ExternalLinkRow href={pr.url}>
          {pr.number != null
            ? `Activation PR #${pr.number} — review + merge`
            : "Activation PR — review + merge"}
        </ExternalLinkRow>
      </StepRow>
    );
  }

  return (
    <StepRow n={3} state={toStepRowState(state)} title="Record activation">
      {state === "current" ? (
        <>
          <p className="text-muted-foreground text-sm">
            {derived.recordPlane.kind === "record_incomplete"
              ? "The repo-spec is active but does not record the deployed distributor. Re-record to pin its address."
              : "After the operator re-verifies the distributor and CAS publishing authority on-chain, this opens a one-file PR writing distributions.status: active, the distributor address, and the claim pattern."}
          </p>
          {submitError ? (
            <p className="text-destructive text-sm">{submitError}</p>
          ) : null}
          <div className="flex items-center gap-3">
            <Button
              type="button"
              onClick={handleRecord}
              disabled={
                submitting || !derived.distributorAddress || !publisherAddress
              }
              className="gap-2"
            >
              {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
              Record activation
            </Button>
            {repoSpecUrl ? (
              <a
                href={repoSpecUrl}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground text-sm hover:text-foreground"
              >
                View repo-spec
              </a>
            ) : null}
          </div>
        </>
      ) : (
        <p className="text-muted-foreground text-sm">
          Deploy the distributor and verify publishing authorization first.
        </p>
      )}
    </StepRow>
  );
}

/**
 * Step 2 — authorize publishing (a governance proposal, on-chain plane). Deploys the scoped
 * DistributionPublishCondition(token, distributor) and submits ONE grantWithCondition proposal.
 * Truth is the paired on-chain permission proof. Only then may step 3 record activation.
 */
function AuthorizeStep({
  state,
  chainId,
  tokenAddress,
  daoAddress,
  pluginAddress,
  distributorAddress,
  wallet,
  walletReady,
  onAuthorized,
}: {
  state: SetupStepState;
  chainId: number;
  tokenAddress: `0x${string}`;
  daoAddress: `0x${string}`;
  pluginAddress: `0x${string}` | null;
  distributorAddress: `0x${string}` | null;
  wallet: `0x${string}` | null;
  walletReady: boolean;
  onAuthorized: () => void;
}): ReactElement {
  if (state === "done") {
    return (
      <StepRow n={2} state="done" title="Publishing authorized">
        <p className="text-muted-foreground text-sm">
          Your wallet holds scoped authority to publish this node&apos;s
          distributions — and nothing else (verified on-chain).
        </p>
      </StepRow>
    );
  }

  return (
    <StepRow n={2} state={toStepRowState(state)} title="Authorize publishing">
      {state === "current" ? (
        <AuthorizeStepBody
          chainId={chainId}
          tokenAddress={tokenAddress}
          daoAddress={daoAddress}
          pluginAddress={pluginAddress}
          distributorAddress={distributorAddress}
          wallet={wallet}
          walletReady={walletReady}
          onAuthorized={onAuthorized}
        />
      ) : (
        <p className="pl-0 text-muted-foreground text-sm">
          Grant your wallet scoped authority to publish — available once the
          distributor is deployed and verified on-chain.
        </p>
      )}
    </StepRow>
  );
}

/** The live authorize flow (only mounted when step 2 is current). */
function AuthorizeStepBody({
  chainId,
  tokenAddress,
  daoAddress,
  pluginAddress,
  distributorAddress,
  wallet,
  walletReady,
  onAuthorized,
}: {
  chainId: number;
  tokenAddress: `0x${string}`;
  daoAddress: `0x${string}`;
  pluginAddress: `0x${string}` | null;
  distributorAddress: `0x${string}` | null;
  wallet: `0x${string}` | null;
  walletReady: boolean;
  onAuthorized: () => void;
}): ReactElement {
  const ready = Boolean(
    walletReady && wallet && pluginAddress && distributorAddress
  );

  const { phase, deployTx, grantTx, error, authorize } = useAuthorizePublishing(
    {
      token: tokenAddress,
      distributor:
        distributorAddress ?? "0x0000000000000000000000000000000000000000",
      dao: daoAddress,
      plugin: pluginAddress ?? "0x0000000000000000000000000000000000000000",
      wallet: wallet ?? "0x0000000000000000000000000000000000000000",
    }
  );

  // Re-read the on-chain permission the moment the grant confirms so the sequence advances.
  // Effect, not render-body — otherwise onAuthorized re-fires every re-render at phase "done".
  useEffect(() => {
    if (phase === "done") onAuthorized();
  }, [phase, onAuthorized]);

  const busy = phase === "deploying" || phase === "granting";
  const explorerTx = grantTx ?? deployTx;
  const explorerUrl = explorerTx
    ? getTransactionExplorerUrl(chainId, explorerTx)
    : null;
  const label =
    phase === "deploying"
      ? "Deploying condition… confirm in wallet"
      : phase === "granting"
        ? "Submitting grant proposal…"
        : "Authorize publishing";

  return (
    <>
      <p className="text-muted-foreground text-sm">
        Grants your wallet permission to publish THIS node&apos;s distributions
        and nothing else (enforced on-chain by a scoped condition contract).
        This IS a governance proposal — two transactions, deploy the condition
        then submit the grant — run once. After this, each epoch publishes in a
        single transaction with no vote.
      </p>

      {!pluginAddress ? (
        <p className="text-muted-foreground text-sm">
          This node is missing its voting-plugin address; authorize can&apos;t
          run yet.
        </p>
      ) : !distributorAddress ? (
        <p className="text-muted-foreground text-sm">
          Deploy the distributor first — the scoped condition binds to its
          address.
        </p>
      ) : !walletReady ? (
        <p className="text-muted-foreground text-sm">
          Connect the owner wallet on the node&apos;s chain to authorize.
        </p>
      ) : null}

      <Button
        type="button"
        onClick={authorize}
        disabled={busy || !ready}
        className="gap-2"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        {label}
      </Button>

      {explorerUrl && busy ? (
        <ExternalLinkRow href={explorerUrl}>
          {grantTx ? "View proposal transaction" : "View deploy transaction"}
        </ExternalLinkRow>
      ) : null}

      {error ? (
        <p className="text-destructive text-sm">
          {error.message?.includes("User rejected")
            ? "Transaction cancelled."
            : (error.message ?? "Authorization failed")}
        </p>
      ) : null}
    </>
  );
}

/** Map the derived step state onto the shared stepper's display state (1:1 today). */
function toStepRowState(state: SetupStepState): StepState {
  return state;
}

/** A small external-link row (icon + label), matching the neighboring idiom. */
function ExternalLinkRow({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}): ReactElement {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 text-primary text-sm hover:underline"
    >
      {children}
      <ExternalLink className="size-3.5" />
    </a>
  );
}
