// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Fixed purpose-only private client. No caller header/path/host forwarding. */
import { request as httpRequest } from "node:http";
import type { ComputeReleaseProofPort } from "@/ports/compute-release-proof.port";
import type { ComputeReleaseProofInput, ComputeReleaseProofOutput } from "@/types/compute-release-proof";
import { COMPUTE_PROOF_PATH, ComputeProofRequestSchema, ComputeProofResponseSchema } from "@/contracts/compute.release-proof.v1.contract";
import { createHash } from "node:crypto";
import { canonicalProofJson } from "@/shared/compute-release-proof-canonical";
export class ComputeReleaseProofClient implements ComputeReleaseProofPort {
 private readonly origin:string;
 constructor(namespace:string,private readonly token:string){
  if(!/^cogni-(candidate-a|preview|production)$/.test(namespace))throw new Error("unavailable");
  this.origin=`http://akash-tx-actuator.${namespace}.svc.cluster.local:8080`;
 }
 async sample(raw:ComputeReleaseProofInput,signal:AbortSignal):Promise<ComputeReleaseProofOutput>{
  if(!/^[0-9a-f]{64}$/.test(this.token))throw new Error("unavailable");
  const input=ComputeProofRequestSchema.parse(raw);signal.throwIfAborted();
  const body=JSON.stringify(input);
  const response=await new Promise<string>((resolve,reject)=>{
   let result:string|undefined;let failed=false;let ended=false;
   const req=httpRequest(new URL(COMPUTE_PROOF_PATH,this.origin),{method:"POST",signal,headers:{"content-type":"application/json","content-length":Buffer.byteLength(body),authorization:`Bearer ${this.token}`}},res=>{
    const chunks:Buffer[]=[];let size=0;
    res.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>65536){failed=true;req.destroy();return}chunks.push(chunk)});
    res.on("error",()=>{failed=true;req.destroy()});
    res.on("end",()=>{ended=true;if(res.statusCode!==200)failed=true;else result=Buffer.concat(chunks).toString("utf8")});
   });
   req.on("error",()=>{failed=true});
   req.on("close",()=>{if(failed||!ended||signal.aborted)reject(new Error("unavailable"));else resolve(result??"")});
   req.end(body);
  });
  signal.throwIfAborted();
  const value=ComputeProofResponseSchema.parse(JSON.parse(response));
  const {workloads:_,...tuple}=input.expected;
  if(value.hash!==createHash("sha256").update(canonicalProofJson(input)).digest("hex")||value.nonce!==input.nonce||canonicalProofJson(value.tuple)!==canonicalProofJson(tuple)||value.dimensions.length!==input.expected.workloads.length||Date.now()-Date.parse(value.observedAt)>20_000||Date.parse(value.observedAt)>Date.now()+1000)throw new Error("unavailable");
  return value;
 }
}
