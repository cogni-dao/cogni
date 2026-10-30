// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * One proof-only service-role connection. Two fixed global session slots and one registered lane.
 * No tables, keyed maps, queues or ordinary wallet-pool changes. Uncertain teardown retires this client.
 */
import postgres, { type ReservedSql, type Sql } from "postgres";
import type { ComputeProofAdmissionLease, ComputeProofAdmissionPort } from "@/ports/compute-release-proof.port";
import type { ComputeReleaseProofInput } from "@/types/compute-release-proof";
export class PostgresComputeProofAdmission implements ComputeProofAdmissionPort {
 private sql:Sql|undefined;
 private retired=false;
 constructor(private readonly dsn:string){}
 private client():Sql{
  if(this.retired)throw new Error("unavailable");
  return this.sql??=(postgres(this.dsn,{max:1,connect_timeout:1,idle_timeout:20,connection:{application_name:"compute-release-proof",statement_timeout:100,lock_timeout:100}}));
 }
 async acquire(input:ComputeReleaseProofInput,parent:AbortSignal):Promise<ComputeProofAdmissionLease>{
  parent.throwIfAborted();const sql=this.client();
  const controller=new AbortController();const signal=AbortSignal.any([parent,controller.signal]);
  let reserved:ReservedSql|undefined;let timer:ReturnType<typeof setTimeout>|undefined;
  const retire=async()=>{this.retired=true;controller.abort();await sql.end({timeout:0});};
  // Closing the proof-only client destroys its real transport; never infer settlement from a race.
  const reserve=sql.reserve();reserve.catch(()=>{});
  try{
   const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("unavailable")),100)});
   try{reserved=await Promise.race([reserve,timeout]);}
   catch{await retire();try{const late=await reserve;late.release();}catch{}throw new Error("unavailable");}
   finally{clearTimeout(timer);}
   const session=reserved;
   const original=<T>(promise:PromiseLike<T>):Promise<T>=>{
    const settled=Promise.resolve(promise);
    const abort=()=>{void retire().catch(()=>{});};
    signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
    return settled.finally(()=>signal.removeEventListener("abort",abort));
   };
   // Session locks, never transaction/pool locks. Every operation is fixed parameterized SQL.
   await original(session`SET statement_timeout = 100`);
   const slots=await original(session<{slot:number}[]>`SELECT slot FROM (SELECT CASE WHEN pg_try_advisory_lock(5390,0) THEN 0 WHEN pg_try_advisory_lock(5390,1) THEN 1 ELSE NULL END AS slot) s WHERE slot IS NOT NULL`);
   if(slots.length!==1)throw new Error("unavailable");
   const rows=await original(session<{slug:string;repo_owner:string;repo_name:string;deploy_envs:string[]}[]>`SELECT slug,repo_owner,repo_name,deploy_envs FROM nodes WHERE id=${input.expected.nodeId}::uuid LIMIT 1`);
   const row=rows[0];if(!row||`${row.repo_owner}/${row.repo_name}`!==input.expected.repository||!row.deploy_envs.includes(input.expected.environment))throw new Error("unavailable");
   const locks=await original(session<{locked:boolean}[]>`SELECT pg_try_advisory_lock(hashtextextended('compute-release-proof:' || ${input.expected.nodeId} || ':' || ${input.expected.environment},0)) AS locked`);
   if(locks[0]?.locked!==true)throw new Error("unavailable");
   signal.throwIfAborted();
   let stopped=false;let health:Promise<void>=Promise.resolve();let healthTimer:ReturnType<typeof setTimeout>|undefined;
   const tick=()=>{healthTimer=setTimeout(()=>{if(stopped)return;health=(async()=>{try{await original(session`SELECT 1`);signal.throwIfAborted();if(!stopped)tick();}catch{await retire();}})();},750)};
   tick();
   return {signal,release:async()=>{
    stopped=true;clearTimeout(healthTimer);await health;
    try{if(!this.retired)await original(session`SELECT pg_advisory_unlock_all()`);}catch{await retire();}
    session.release();
   }};
  }catch{
   // A failed admission must not leave either session lock in a pooled backend.
   await retire();reserved?.release();throw new Error("unavailable");
  }
 }
}
