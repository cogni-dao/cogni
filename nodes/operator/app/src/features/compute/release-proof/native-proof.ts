// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Current native observation only. GET/list/log and owned ledger reads; no ensure/exec/Secret.
 * All original promises settle before sample returns, including after deadline or disconnect.
 */
import { parse as parseYaml } from "yaml";
import type { AkashTxAllocationLedgerPort, AkashTxConsolePort } from "@/ports";
import type { ComputeReleaseProofPort } from "@/ports/compute-release-proof.port";
import type { ComputeReleaseProofInput, ComputeReleaseProofOutput, ProofVerdict } from "@/types/compute-release-proof";
import { ComputeProofRequestSchema } from "@/contracts/compute.release-proof.v1.contract";
import { assessComputeWorkloadReadiness } from "@/features/compute/compute-workload-readiness";
import { cogniNodeAppMigrationPhases } from "@/features/compute/akash-tx/akash-tx-migration-step";
import { canonicalProofJson, computeProofHash } from "@/features/compute/release-proof/request";
import { commandTemplate, projectService, record } from "@/features/compute/release-proof/projection";
import { withDatabaseCaTrust } from "@/shared/secrets/database-ca-command";
import { parseMigrationReceipt, diffDeclaredVsApplied } from "@/shared/migrations/migration-receipt";
import type { ProofKubeReadClient } from "@/ports/compute-release-proof.port";

type Workload = ComputeReleaseProofInput["expected"]["workloads"][number];
const same=(a:unknown,b:unknown)=>canonicalProofJson(a)===canonicalProofJson(b);
const array=(v:unknown):unknown[]=>{if(!Array.isArray(v)||v.length>64)throw new Error("unavailable");return v};
function list(v:unknown):unknown[]{const r=record(v);if(record(r.metadata??{}).continue)throw new Error("unavailable");const items=array(r.items);if(items.length>=9)throw new Error("unavailable");return items;}
const segment=(s:string)=>encodeURIComponent(s);
export class NativeComputeReleaseProofAdapter implements ComputeReleaseProofPort {
 constructor(private readonly kube:ProofKubeReadClient,private readonly ledger:Pick<AkashTxAllocationLedgerPort,"listAllocated">,private readonly provider:Pick<AkashTxConsolePort,"readManagedDefinition">){}
 async sample(raw:ComputeReleaseProofInput,parent:AbortSignal):Promise<ComputeReleaseProofOutput>{
  const input=ComputeProofRequestSchema.parse(raw);parent.throwIfAborted();
  const signal=AbortSignal.any([parent,AbortSignal.timeout(20_000)]);
  const dimensions:ComputeReleaseProofOutput["dimensions"][number][]=[];
  // Sequential native operations are deliberately below the <=2 fanout bound.
  for(const w of input.expected.workloads){
   const name=input.expected.nodeId+(w.instance===null?"":`-${w.instance}`);
   let native:ProofVerdict="unavailable",migration:ProofVerdict="unavailable",provider:ProofVerdict="unavailable";
   let code:ComputeReleaseProofOutput["dimensions"][number]["code"]="unavailable";
   try{
    signal.throwIfAborted();
    const ns=`cogni-${input.expected.environment}`;
    const plural=w.kind==="XComputeWorkload"?"xcomputeworkloads":"computeworkloads";
    const live=record(await this.kube.json(`/apis/compute.cogni.io/v1alpha1/namespaces/${ns}/${plural}/${name}`,signal));
    const metadata=record(live.metadata),spec=record(live.spec),bundle=record(spec.bundle),source=record(bundle.source),workload=record(spec.workload);
    const slug=workload.name;
    if(typeof slug!=="string"||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)||metadata.name!==name||metadata.namespace!==ns||spec.nodeId!==input.expected.nodeId||spec.environment!==input.expected.environment||source.repository!==input.expected.repository||record(metadata.labels)["cogni.io/node-id"]!==input.expected.nodeId||record(metadata.labels)["cogni.io/environment"]!==input.expected.environment||record(metadata.labels)["cogni.io/node"]!==slug||(spec.instance??null)!==w.instance)throw new Error("ownership");
    if(source.sha!==input.expected.sourceSha)throw new Error("wrong_source");
    if(bundle.ref!==input.expected.bundleRef||!same(bundle.artifacts,w.artifacts))throw new Error("stale_bundle");
    const projected=array(workload.services).map(projectService);
    if(!same(projected,w.services)||workload.publicHost!==(w.publicHost??"")||(spec.leaseGeneration??0)!==w.leaseGeneration)throw new Error("stale_bundle");
    const ready=assessComputeWorkloadReadiness({expected:{apiVersion:"compute.cogni.io/v1alpha1",kind:w.kind,metadata:{name,namespace:ns},spec:{nodeId:input.expected.nodeId,environment:input.expected.environment,bundle:{ref:input.expected.bundleRef,source:{repository:input.expected.repository,sha:input.expected.sourceSha},artifacts:w.artifacts},workload:{name:slug,publicHost:w.publicHost??"",services:array(workload.services)},...(w.kind==="XComputeWorkload"?{leaseGeneration:w.leaseGeneration,migration:{policy:"RequireBeforeServing"},...(w.instance===null?{}:{instance:w.instance})}:{})}},live});
    if(!ready.ready)throw new Error("actuator_lag");
    native="verified";
    // Handle comes only from the owned allocation. The public input cannot select one.
    const rows=await this.ledger.listAllocated({nodeId:input.expected.nodeId,environment:input.expected.environment,limit:33});signal.throwIfAborted();
    if(rows.length>=33)throw new Error("ownership");
    const matches=rows.filter(r=>r.workload===slug&&r.identity.nodeId===input.expected.nodeId&&r.identity.compositeUid===metadata.uid&&r.identity.compositeGeneration===metadata.generation&&r.state==="allocated"&&r.externalName);
    if(matches.length!==1)throw new Error("ownership");
    const allocation=matches[0]!;
    if(!this.provider.readManagedDefinition||!allocation.externalName)throw new Error("provider_unavailable");
    const observed=await this.provider.readManagedDefinition({leaseId:allocation.externalName,signal});signal.throwIfAborted();
    if(observed.leaseId!==allocation.externalName||observed.providerAccount!==allocation.providerAccount||observed.consoleManifestVersion!==observed.chainManifestVersion)throw new Error("provider_unavailable");
    this.checkProvider(w,observed);
    provider="verified";
    migration=await this.migration(input,w,slug,ns,signal);
    code=migration==="verified"?"verified":migration==="failed"?"migration_failed":migration==="running"?"migration_running":"migration_unavailable";
   }catch(error){
    const finite=["ownership","wrong_source","stale_bundle","actuator_lag","unsupported_command","provider_unavailable"] as const;
    const message=error instanceof Error?error.message:"";
    code=finite.find(x=>x===message)??"unavailable";
    if(code==="actuator_lag")native="running";
   }
   if(signal.aborted){native="unavailable";migration="unavailable";provider="unavailable";code="unavailable";}
   dimensions.push({workload:name,native,migration,provider,code});
  }
  // A late original call is never allowed to produce a positive sample.
  if(signal.aborted)for(let i=0;i<dimensions.length;i++)dimensions[i]={...dimensions[i]!,native:"unavailable",migration:"unavailable",provider:"unavailable",code:"unavailable"};
  const {workloads:_,...tuple}=input.expected;
  return {version:1,hash:computeProofHash(input),nonce:input.nonce,tuple,observedAt:new Date().toISOString(),dimensions};
 }
 private checkProvider(w:Workload,observed:Awaited<ReturnType<NonNullable<AkashTxConsolePort["readManagedDefinition"]>>>):void{
  const sdl=record(parseYaml(observed.providerSdl)),services=record(sdl.services),compute=record(record(sdl.profiles).compute),deployment=record(sdl.deployment);
  if(!same(Object.keys(services).sort(),w.services.map(s=>s.name).sort())||!same(Object.keys(compute).sort(),Object.keys(services).sort())||!same(Object.keys(deployment).sort(),Object.keys(services).sort())||observed.services.length!==w.services.length)throw new Error("provider_unavailable");
  for(const service of w.services){
   const s=record(services[service.name]),artifact=w.artifacts.find(a=>a.name===service.artifact),resources=record(record(compute[service.name]).resources);
   if(s.image!==artifact?.image||commandTemplate(s)!==service.commandTemplate||record(resources.cpu).units!==service.cpuUnits||record(resources.memory).size!==`${service.memoryMi}Mi`||!same(resources.storage,[{size:`${service.storageMi}Mi`}]))throw new Error("provider_unavailable");
   const expectedExpose=[{port:service.port,as:service.port,...(service.visibility==="public"?{accept:[w.publicHost],to:[{global:true}]}:{to:w.services.filter(x=>x.name!==service.name).map(x=>({service:x.name}))})}];
   if(!same(s.expose,expectedExpose))throw new Error("provider_unavailable");
   const groups=Object.values(record(deployment[service.name]));if(groups.length!==1||record(groups[0]).profile!==service.name||record(groups[0]).count!==1)throw new Error("provider_unavailable");
   const rollout=observed.services.find(r=>r.name===service.name);
   if(!rollout||rollout.observedGeneration<1||[rollout.replicas,rollout.updatedReplicas,rollout.readyReplicas,rollout.availableReplicas,rollout.total,rollout.available].some(n=>n!==1))throw new Error("provider_unavailable");
   // Keys only; provider secret/env values are neither compared nor returned/hashed.
   const env=array(s.env??[]).map(x=>{if(typeof x!=="string"||!x.includes("="))throw new Error("provider_unavailable");return x.slice(0,x.indexOf("="))});
   if(new Set(env).size!==env.length||[...service.secretRefs.map(r=>r.key==="LITELLM_VIRTUAL_KEY"&&service.runtimeProfile==="cogni-node-app-v1"?"LITELLM_MASTER_KEY":r.key),...service.bindings.map(b=>b.key)].some(k=>!env.includes(k)))throw new Error("provider_unavailable");
  }
 }
 private async migration(input:ComputeReleaseProofInput,w:Workload,slug:string,ns:string,signal:AbortSignal):Promise<ProofVerdict>{
  const apps=w.services.filter(s=>s.runtimeProfile==="cogni-node-app-v1");
  if(apps.length===0)return "verified";if(apps.length!==1)return "unavailable";
  const app=apps[0]!,image=w.artifacts.find(a=>a.name===app.artifact)?.image;
  const digest=input.expected.bundleRef.split("@sha256:")[1];if(!digest)return "unavailable";
  const jobName=`migrate-${slug}-${digest.slice(0,12)}`;
  const job=record(await this.kube.json(`/apis/batch/v1/namespaces/${ns}/jobs/${segment(jobName)}`,signal)),meta=record(job.metadata),labels=record(meta.labels),status=record(job.status??{});
  if(meta.name!==jobName||meta.namespace!==ns||typeof meta.uid!=="string"||meta.deletionTimestamp||labels["cogni.io/node"]!==slug||labels["cogni.io/environment"]!==input.expected.environment||labels["app.kubernetes.io/managed-by"]!=="compute-workload-controller")return "unavailable";
  const conditions=array(status.conditions??[]);
  if(conditions.some(x=>record(x).type==="Failed"&&record(x).status==="True"))return "failed";
  if(!conditions.some(x=>record(x).type==="Complete"&&record(x).status==="True")||Number(status.active??0)>0)return "running";
  const phases=cogniNodeAppMigrationPhases({doltgres:app.secretRefs.some(r=>r.key==="DOLTGRES_URL")});
  const template=record(record(record(job.spec).template).spec),containers=[...array(template.initContainers??[]),...array(template.containers)];
  if(containers.length!==phases.length)return "unavailable";
  for(let i=0;i<phases.length;i++){
   const phase=phases[i]!,container=record(containers[i]),sealed=withDatabaseCaTrust(phase.command);
   if(container.name!==phase.name||container.image!==image||!same(container.command,sealed.command)||!same(container.args,sealed.args))return "unavailable";
   const env=array(container.env),db=env.map(record).find(e=>e.name==="DATABASE_URL");
   if(!db||!same(record(db.valueFrom).secretKeyRef,{name:`${slug}-compute-migration-secrets`,key:phase.databaseUrlSecretKey}))return "unavailable";
  }
  const pods=list(await this.kube.json(`/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}&limit=9`,signal));
  const owned=pods.map(record).filter(p=>array(record(p.metadata).ownerReferences??[]).some(o=>record(o).uid===meta.uid&&record(o).kind==="Job"&&record(o).controller===true));
  if(owned.length!==1)return "unavailable";
  const pod=owned[0]!,podMeta=record(pod.metadata),podStatus=record(pod.status),podSpec=record(pod.spec);
  if(podMeta.namespace!==ns||typeof podMeta.name!=="string"||podMeta.deletionTimestamp||podStatus.phase!=="Succeeded"||!same([...array(podSpec.initContainers??[]),...array(podSpec.containers)],containers))return "unavailable";
  const states=[...array(podStatus.initContainerStatuses??[]),...array(podStatus.containerStatuses??[])].map(record);
  for(const phase of phases){
   const state=states.find(x=>x.name===phase.name);if(!state||state.image!==image||record(record(state.state).terminated).exitCode!==0)return "unavailable";
   const log=await this.kube.log(`/api/v1/namespaces/${ns}/pods/${segment(podMeta.name)}/log?container=${segment(phase.name)}&limitBytes=65536`,signal);
   if(phase.name==="migrate"){
    const receipt=parseMigrationReceipt(log);if(!receipt||receipt.node!==slug||new Set(receipt.declared).size!==receipt.declared.length||diffDeclaredVsApplied(receipt).missing.length>0)return "unavailable";
   }else if(!log.split("\n").some(line=>line.includes(`${slug} migrate complete:`)&&line.includes("migration(s) applied + verified +")&&(line.includes("owned branch committed")||line.includes("read-only no-op; no journal DDL or commit"))))return "unavailable";
  }
  return "verified";
 }
}
