// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/DistributionsCard.client`
 * Purpose: One refresh-safe activation ceremony: Deploy → Authorize → Record. A compact lifecycle
 *   rail shows the outcome, while a four-transaction checklist exposes durable chain evidence.
 * Scope: Node-page composition, browser recovery UI, status fetch, activation POST, and wallet gating.
 * Invariants:
 *   - ONE_PRIMARY_ACTION: only the next explicit wallet/server action is primary.
 *   - NO_AUTO_WALLET: receipts and recovered hashes trigger verification, never another write.
 *   - FAIL_CLOSED: hydration, RPC, and receipt uncertainty show Checking/Couldn't verify, not Deploy.
 *   - PUBLIC_RECOVERY_ONLY: browser persistence contains transaction hashes, never authority/secrets.
 * Side-effects: same-origin HTTP, router refresh, browser recovery hints, connected-wallet hooks.
 * Links: src/features/nodes/distribution-activation-recovery.ts,
 *   src/features/nodes/distribution-setup-state.ts,
 *   src/features/nodes/useDeployDistributor.ts,
 *   src/features/governance/hooks/useAuthorizePublishing.ts
 * @public
 */

"use client";

import { getTransactionExplorerUrl } from "@cogni/node-shared";
import { useQuery } from "@tanstack/react-query";
import { Loader2, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type FormEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { isHash } from "viem";
import { useAccount, useChainId, useSwitchChain } from "wagmi";

import {
  Button,
  Input,
  LifecycleProgress,
  type LifecycleProgressStep,
  type Phase,
  PhaseList,
  SectionCard,
  WalletConnectButton,
} from "@/components";
import { useAuthorizePublishing } from "@/features/governance/hooks/useAuthorizePublishing";
import { useHasExecutePermission } from "@/features/governance/hooks/useExecuteDistribution";
import {
  type ActivationRecoveryIdentity,
  type ActivationTransactionHashes,
  type ActivationTransactionKey,
  hasDownstreamEvidenceWithoutDistributor,
  useDistributionActivationRecovery,
} from "@/features/nodes/distribution-activation-recovery";
import {
  type ActivationPrRef,
  type DistributionSetupDerived,
  deriveDistributionSetup,
} from "@/features/nodes/distribution-setup-state";
import {
  type ActivationTransactionState,
  useDeployDistributor,
  useDistributorOnChain,
} from "@/features/nodes/useDeployDistributor";

interface Props {
  readonly nodeId: string;
  readonly slug: string;
  readonly repoSpecUrl: string | null;
  readonly tokenAddress: string | null;
  readonly daoAddress: string | null;
  readonly pluginAddress: string | null;
  readonly chainId: number | null;
  readonly distributionsActive: boolean;
  readonly recordedDistributorAddress: string | null;
}

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

async function fetchRecordStatus(
  nodeId: string
): Promise<DistributionRecordStatus> {
  const response = await fetch(
    `/api/v1/nodes/${encodeURIComponent(nodeId)}/distributions-status`,
    { cache: "no-store" }
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as {
    record?: DistributionRecordStatus;
  };
  if (!body.record) throw new Error("Distribution status was unavailable.");
  return body.record;
}

async function postActivateDistributions(
  nodeId: string,
  body: Record<string, unknown>
): Promise<{ status?: string; prUrl?: string } | null> {
  const response = await fetch(
    `/api/v1/nodes/${encodeURIComponent(nodeId)}/activate-distributions`,
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
    // The raw response remains useful in the error below.
  }
  if (!response.ok) {
    const reason =
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : text.trim() || `HTTP ${response.status}`;
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
  const recordQuery = useQuery({
    queryKey: ["node-distributions-status", nodeId],
    queryFn: () => fetchRecordStatus(nodeId),
    staleTime: 15_000,
    refetchInterval: (query) =>
      query.state.data?.activationPr?.state === "open" ? 30_000 : false,
  });
  const { refetch } = recordQuery;
  const refetchRecord = useCallback(async () => {
    await refetch();
  }, [refetch]);

  return (
    <SectionCard
      title="Activate distributions"
      className="mx-auto mt-4 w-full max-w-2xl"
    >
      <p className="text-muted-foreground text-sm">
        Complete this once so <span className="font-medium">{slug}</span> can
        publish contributor allocations. You can leave or refresh at any time.
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
          recordLoading={recordQuery.isLoading}
          recordError={recordQuery.error as Error | null}
          refetchRecord={refetchRecord}
        />
      ) : (
        <p className="mt-2 text-muted-foreground text-sm">
          Finish DAO and token formation first. Activation becomes available
          when this node has a DAO, token, voting plugin, and chain.
        </p>
      )}
    </SectionCard>
  );
}

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
  recordLoading,
  recordError,
  refetchRecord,
}: {
  readonly nodeId: string;
  readonly slug: string;
  readonly repoSpecUrl: string | null;
  readonly tokenAddress: `0x${string}`;
  readonly daoAddress: `0x${string}`;
  readonly pluginAddress: `0x${string}` | null;
  readonly chainId: number;
  readonly fallbackDistributionsActive: boolean;
  readonly fallbackRecordedDistributorAddress: `0x${string}` | null;
  readonly record: DistributionRecordStatus | null;
  readonly recordLoading: boolean;
  readonly recordError: Error | null;
  readonly refetchRecord: () => Promise<void>;
}): ReactElement {
  const { address, isConnected } = useAccount();
  const connectedChainId = useChainId();
  const { switchChain } = useSwitchChain();
  const [sessionPrUrl, setSessionPrUrl] = useState<string | null>(null);

  const identity = useMemo<ActivationRecoveryIdentity | null>(
    () =>
      address
        ? {
            nodeId,
            chainId,
            tokenAddress,
            daoAddress,
            publisherAddress: address,
          }
        : null,
    [address, chainId, daoAddress, nodeId, tokenAddress]
  );
  const recovery = useDistributionActivationRecovery(identity);
  const recoveryAdapter = useMemo(
    () => ({
      hashes: recovery.hashes,
      onHash: recovery.setHash,
      runGuarded: recovery.runGuarded,
    }),
    [recovery.hashes, recovery.runGuarded, recovery.setHash]
  );
  const deploy = useDeployDistributor(
    tokenAddress,
    daoAddress,
    chainId,
    recoveryAdapter
  );

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
  const knownDistributor = (deploy.distributorAddress ??
    recordedAddress ??
    pendingAddress) as `0x${string}` | null;

  const distributorOnChain = useDistributorOnChain({
    distributorAddress: knownDistributor,
    daoAddress,
    tokenAddress,
    chainId,
  });
  const permission = useHasExecutePermission({
    daoAddress,
    wallet: address,
    tokenAddress,
    distributorAddress: knownDistributor,
    chainId,
  });
  const authorization = useAuthorizePublishing(
    {
      token: tokenAddress,
      distributor:
        knownDistributor ?? "0x0000000000000000000000000000000000000000",
      dao: daoAddress,
      plugin: pluginAddress ?? "0x0000000000000000000000000000000000000000",
      wallet: address ?? "0x0000000000000000000000000000000000000000",
      chainId,
    },
    recoveryAdapter
  );

  const distributorVerified =
    deploy.verificationStatus === "verified" ||
    distributorOnChain.status === "verified";
  const authorized =
    permission.hasPermission === true ||
    authorization.verificationStatus === "verified";
  const unsafeEvidenceGap = hasDownstreamEvidenceWithoutDistributor({
    hashes: recovery.hashes,
    distributorVerified,
  });
  const derived = deriveDistributionSetup({
    repoSpecActive,
    openPr,
    recordedDistributorAddress: recordedAddress,
    pendingDistributorAddress: pendingAddress,
    sessionDistributorAddress: deploy.distributorAddress,
    distributorVerified,
    authorized,
  });

  const transactionChecking = [
    deploy.deployTransaction,
    deploy.transferTransaction,
    authorization.conditionTransaction,
    authorization.grantTransaction,
  ].some((transaction) =>
    ["submitted", "confirming"].includes(transaction.status)
  );
  const checking =
    recordLoading ||
    (isConnected && !recovery.hydrated) ||
    transactionChecking ||
    (Boolean(deploy.deployTransaction.hash) &&
      deploy.verificationStatus === "checking") ||
    (Boolean(knownDistributor) && distributorOnChain.status === "loading") ||
    (Boolean(authorization.conditionTransaction.hash) &&
      authorization.verificationStatus === "checking") ||
    (distributorVerified &&
      authorization.verificationStatus !== "verified" &&
      permission.isLoading);
  const unavailable =
    Boolean(recordError) ||
    unsafeEvidenceGap ||
    [
      deploy.deployTransaction,
      deploy.transferTransaction,
      authorization.conditionTransaction,
      authorization.grantTransaction,
    ].some((transaction) => transaction.status === "unknown") ||
    deploy.verificationStatus === "unavailable" ||
    (Boolean(knownDistributor) &&
      ["mismatch", "unavailable"].includes(distributorOnChain.status) &&
      deploy.verificationStatus !== "needs_transfer" &&
      deploy.verificationStatus !== "verified") ||
    (deploy.transferTransaction.status === "confirmed" &&
      deploy.verificationStatus === "mismatch") ||
    (Boolean(authorization.conditionTransaction.hash) &&
      authorization.conditionTransaction.status !== "failed" &&
      authorization.grantTransaction.status !== "failed" &&
      ["unavailable", "mismatch"].includes(authorization.verificationStatus)) ||
    (distributorVerified &&
      !authorized &&
      Boolean(permission.error) &&
      !authorization.conditionTransaction.hash);

  const requiresChain = derived.currentStep === 1 || derived.currentStep === 2;
  const walletReady = isConnected && connectedChainId === chainId;
  const phases = transactionPhases(chainId, deploy, authorization);

  return (
    <div className="mt-4 space-y-5">
      <LifecycleProgress
        ariaLabel="Distribution activation progress"
        steps={lifecycleSteps(derived, checking || unavailable)}
      />

      <div className="rounded-lg border border-border bg-muted/20 p-4">
        <p className="mb-3 font-medium text-sm">Transaction checkpoints</p>
        <PhaseList phases={phases} />
      </div>

      {!isConnected ? (
        <div className="space-y-2">
          <p className="text-muted-foreground text-sm">
            Connect the node owner wallet to continue or recover this setup.
          </p>
          <WalletConnectButton />
        </div>
      ) : requiresChain && !walletReady ? (
        <Button type="button" onClick={() => switchChain?.({ chainId })}>
          Switch network to continue
        </Button>
      ) : checking ? (
        <StatusMessage kind="checking" />
      ) : unavailable ? (
        <StatusMessage kind="unavailable" />
      ) : (
        <NextAction
          derived={derived}
          deploy={deploy}
          authorization={authorization}
          pluginAddress={pluginAddress}
          publisherAddress={address ?? null}
          nodeId={nodeId}
          repoSpecUrl={repoSpecUrl}
          deployTx={
            deploy.deployTransaction.hash ?? recovery.hashes.deployDistributor
          }
          onRecorded={async (prUrl) => {
            if (prUrl) setSessionPrUrl(prUrl);
            await refetchRecord();
          }}
        />
      )}

      {deploy.error || authorization.error ? (
        <p role="alert" className="text-destructive text-sm">
          {deploy.error ?? authorization.error}
        </p>
      ) : null}

      {identity && derived.recordPlane.kind !== "recorded" ? (
        <RecoveryEditor
          hashes={recovery.hashes}
          onSave={recovery.replaceHashes}
        />
      ) : null}

      {derived.currentStep === null ? (
        <p className="text-primary text-sm">
          {derived.recordPlane.kind === "pr_open"
            ? `Activation PR open for ${slug}. Merge it to persist the record.`
            : "Distribution activation is complete."}
        </p>
      ) : null}
    </div>
  );
}

function lifecycleSteps(
  derived: DistributionSetupDerived,
  uncertain: boolean
): readonly LifecycleProgressStep[] {
  const convert = (
    state: "done" | "awaiting" | "current" | "pending"
  ): LifecycleProgressStep["state"] =>
    state === "done"
      ? "complete"
      : state === "current" || state === "awaiting"
        ? "current"
        : "pending";
  const steps: LifecycleProgressStep[] = [
    { label: "Deploy", state: convert(derived.steps.deploy) },
    { label: "Authorize", state: convert(derived.steps.authorize) },
    { label: "Record", state: convert(derived.steps.record) },
  ];
  if (!uncertain) return steps;
  return steps.map<LifecycleProgressStep>((step) =>
    step.state === "current"
      ? { ...step, state: "unknown", description: "Verification in progress" }
      : step
  );
}

function transactionPhases(
  chainId: number,
  deploy: ReturnType<typeof useDeployDistributor>,
  authorization: ReturnType<typeof useAuthorizePublishing>
): readonly Phase[] {
  const row = (
    label: string,
    transaction: ActivationTransactionState
  ): Phase => {
    const href = transaction.hash
      ? getTransactionExplorerUrl(chainId, transaction.hash)
      : null;
    return {
      label,
      state:
        transaction.status === "confirmed"
          ? "done"
          : transaction.status === "failed" || transaction.status === "unknown"
            ? "error"
            : transaction.status === "pending"
              ? "pending"
              : "active",
      detail:
        transaction.status === "pending"
          ? "Not started"
          : transaction.status === "submitted"
            ? "Submitted"
            : transaction.status === "confirming"
              ? "Confirming"
              : transaction.status === "confirmed"
                ? "Confirmed"
                : transaction.status === "failed"
                  ? "Failed"
                  : "Couldn’t verify",
      ...(href ? { href } : {}),
    };
  };
  return [
    row("Deploy distributor", deploy.deployTransaction),
    row("Transfer ownership to DAO", deploy.transferTransaction),
    row("Deploy publish condition", authorization.conditionTransaction),
    row("Grant scoped permission", authorization.grantTransaction),
  ];
}

function StatusMessage({
  kind,
}: {
  readonly kind: "checking" | "unavailable";
}): ReactElement {
  if (kind === "checking") {
    return (
      <output className="flex items-center gap-2 text-sm">
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        <span>Checking confirmed transactions and on-chain setup…</span>
      </output>
    );
  }
  return (
    <div role="alert" className="space-y-2">
      <p className="text-destructive text-sm">
        Couldn&apos;t verify this setup. No transaction will be sent.
      </p>
      <Button
        type="button"
        variant="outline"
        onClick={() => window.location.reload()}
        className="gap-2"
      >
        <RotateCcw aria-hidden="true" className="size-4" />
        Check again
      </Button>
    </div>
  );
}

function NextAction({
  derived,
  deploy,
  authorization,
  pluginAddress,
  publisherAddress,
  nodeId,
  repoSpecUrl,
  deployTx,
  onRecorded,
}: {
  readonly derived: DistributionSetupDerived;
  readonly deploy: ReturnType<typeof useDeployDistributor>;
  readonly authorization: ReturnType<typeof useAuthorizePublishing>;
  readonly pluginAddress: `0x${string}` | null;
  readonly publisherAddress: `0x${string}` | null;
  readonly nodeId: string;
  readonly repoSpecUrl: string | null;
  readonly deployTx: `0x${string}` | undefined;
  readonly onRecorded: (prUrl: string | null) => Promise<void>;
}): ReactElement {
  if (derived.recordPlane.kind === "recorded") {
    return repoSpecUrl ? (
      <a
        href={repoSpecUrl}
        target="_blank"
        rel="noreferrer"
        className="text-primary text-sm underline-offset-4 hover:underline"
      >
        View active repo-spec
      </a>
    ) : (
      <p className="text-muted-foreground text-sm">Activation recorded.</p>
    );
  }
  if (derived.recordPlane.kind === "pr_open") {
    return (
      <a
        href={derived.recordPlane.pr.url}
        target="_blank"
        rel="noreferrer"
        className="text-primary text-sm underline-offset-4 hover:underline"
      >
        Review activation PR
        {derived.recordPlane.pr.number
          ? ` #${derived.recordPlane.pr.number}`
          : ""}
      </a>
    );
  }
  if (derived.currentStep === 1) {
    if (deploy.deployTransaction.status === "failed") {
      return (
        <ActionButton
          label="Retry distributor deploy"
          onClick={deploy.deploy}
        />
      );
    }
    if (deploy.verificationStatus === "needs_transfer") {
      return (
        <ActionButton
          label={
            deploy.transferTransaction.status === "failed"
              ? "Retry ownership transfer"
              : "Transfer ownership to DAO"
          }
          onClick={deploy.transferOwnership}
        />
      );
    }
    return <ActionButton label="Deploy distributor" onClick={deploy.deploy} />;
  }
  if (derived.currentStep === 2) {
    if (!pluginAddress) {
      return (
        <p className="text-muted-foreground text-sm">
          This node is missing its voting-plugin address.
        </p>
      );
    }
    if (authorization.conditionTransaction.status === "failed") {
      return (
        <ActionButton
          label="Retry publish condition deploy"
          onClick={authorization.deployCondition}
        />
      );
    }
    if (authorization.grantTransaction.status === "failed") {
      return (
        <ActionButton
          label="Retry scoped permission grant"
          onClick={authorization.grantPermission}
        />
      );
    }
    if (authorization.verificationStatus === "condition_verified") {
      return (
        <ActionButton
          label="Grant scoped permission"
          onClick={authorization.grantPermission}
        />
      );
    }
    return (
      <ActionButton
        label="Deploy publish condition"
        onClick={authorization.deployCondition}
      />
    );
  }
  if (derived.currentStep === 3) {
    return (
      <RecordAction
        nodeId={nodeId}
        distributorAddress={derived.distributorAddress}
        publisherAddress={publisherAddress}
        deployTx={deployTx}
        onRecorded={onRecorded}
      />
    );
  }
  return <p className="text-muted-foreground text-sm">No action needed.</p>;
}

function ActionButton({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => Promise<void>;
}): ReactElement {
  const [running, setRunning] = useState(false);
  return (
    <Button
      type="button"
      disabled={running}
      onClick={() => {
        setRunning(true);
        void onClick().finally(() => setRunning(false));
      }}
      className="gap-2"
    >
      {running ? (
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      ) : null}
      {label}
    </Button>
  );
}

function RecordAction({
  nodeId,
  distributorAddress,
  publisherAddress,
  deployTx,
  onRecorded,
}: {
  readonly nodeId: string;
  readonly distributorAddress: string | null;
  readonly publisherAddress: `0x${string}` | null;
  readonly deployTx: `0x${string}` | undefined;
  readonly onRecorded: (prUrl: string | null) => Promise<void>;
}): ReactElement {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleRecord = async () => {
    if (submitting || !distributorAddress || !publisherAddress) return;
    setSubmitting(true);
    setError(null);
    try {
      const activation = await postActivateDistributions(nodeId, {
        distributorAddress,
        publisherAddress,
        ...(deployTx ? { deployTx } : {}),
      });
      await onRecorded(
        activation?.status === "pr_opened" && activation.prUrl
          ? activation.prUrl
          : null
      );
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Recording failed.");
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="space-y-2">
      <Button
        type="button"
        onClick={handleRecord}
        disabled={submitting || !distributorAddress || !publisherAddress}
        className="gap-2"
      >
        {submitting ? (
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        ) : null}
        Record activation
      </Button>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const RECOVERY_FIELDS: readonly {
  key: ActivationTransactionKey;
  label: string;
}[] = [
  { key: "deployDistributor", label: "Distributor deploy hash" },
  { key: "transferOwnership", label: "Ownership transfer hash" },
  { key: "deployCondition", label: "Condition deploy hash" },
  { key: "grantPermission", label: "Permission grant hash" },
];

function RecoveryEditor({
  hashes,
  onSave,
}: {
  readonly hashes: ActivationTransactionHashes;
  readonly onSave: (hashes: ActivationTransactionHashes) => void;
}): ReactElement {
  const [values, setValues] = useState<
    Record<ActivationTransactionKey, string>
  >({
    deployDistributor: hashes.deployDistributor ?? "",
    transferOwnership: hashes.transferOwnership ?? "",
    deployCondition: hashes.deployCondition ?? "",
    grantPermission: hashes.grantPermission ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setValues({
      deployDistributor: hashes.deployDistributor ?? "",
      transferOwnership: hashes.transferOwnership ?? "",
      deployCondition: hashes.deployCondition ?? "",
      grantPermission: hashes.grantPermission ?? "",
    });
  }, [hashes]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Partial<Record<ActivationTransactionKey, `0x${string}`>> = {};
    for (const field of RECOVERY_FIELDS) {
      const value = values[field.key].trim();
      if (!value) continue;
      if (!isHash(value)) {
        setError(`${field.label} is not a transaction hash.`);
        return;
      }
      next[field.key] = value;
    }
    if (Object.keys(next).length === 0) {
      setError("Enter at least one transaction hash.");
      return;
    }
    setError(null);
    onSave(next);
  };

  return (
    <details className="rounded-lg border border-border p-3">
      <summary className="cursor-pointer font-medium text-sm">
        Recover past transactions
      </summary>
      <form onSubmit={submit} className="mt-3 space-y-3">
        <p className="text-muted-foreground text-sm">
          Paste known transaction hashes. They are checked against this
          node&apos;s token, DAO, distributor, condition, and permission before
          continuing.
        </p>
        {RECOVERY_FIELDS.map((field) => (
          <div key={field.key} className="space-y-1 text-sm">
            <label htmlFor={`recovery-${field.key}`}>{field.label}</label>
            <Input
              id={`recovery-${field.key}`}
              value={values[field.key]}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  [field.key]: event.target.value,
                }))
              }
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        ))}
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="outline">
          Check transaction hashes
        </Button>
      </form>
    </details>
  );
}
