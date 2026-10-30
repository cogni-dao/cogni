// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Public strict comparison, not release approval. Caller headers never cross the private client. */
import { NextResponse } from "next/server";
import { compareReleaseProof } from "@/app/_facades/releases/proof.server";
import { COMPUTE_PROOF_BODY_BYTES, ComputeProofResponseSchema } from "@/contracts/compute.release-proof.v1.contract";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request){
 const signal=AbortSignal.any([request.signal,AbortSignal.timeout(20_000)]);
 const reader=request.body?.getReader();if(!reader||new URL(request.url).search)return NextResponse.json({code:"invalid_request"},{status:400});
 const chunks:Uint8Array[]=[];let bytes=0;
 const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener("abort",abort,{once:true});
 try{
  for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>COMPUTE_PROOF_BODY_BYTES){await reader.cancel();return NextResponse.json({code:"invalid_request"},{status:413});}chunks.push(value);}
  signal.throwIfAborted();
  const result=await compareReleaseProof(Buffer.concat(chunks).toString("utf8"),signal);
  return NextResponse.json(result.status===200?ComputeProofResponseSchema.parse(result.body):result.body,{status:result.status,headers:{"cache-control":"no-store"}});
 }catch{return NextResponse.json({code:signal.aborted?"unavailable":"invalid_request"},{status:signal.aborted?503:400});}
 finally{signal.removeEventListener("abort",abort);reader.releaseLock();}
}
