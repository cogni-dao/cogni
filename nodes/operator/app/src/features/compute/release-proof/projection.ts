// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Public declaration projection. Private values cannot participate in caller equality. */
import { withDatabaseCaTrust } from "@/shared/secrets/database-ca-command";
import { ProofServiceSchema } from "@/contracts/compute.release-proof.v1.contract";
import { canonicalProofJson } from "./request";
export function record(value:unknown):Record<string,unknown> {
 if(!value || typeof value!=="object" || Array.isArray(value))throw new Error("unavailable");
 return value as Record<string,unknown>;
}
export function commandTemplate(value:Record<string,unknown>):string {
 if(value.command===undefined && value.args===undefined)return "image-default";
 const sealed=withDatabaseCaTrust(["node","app/server.js"]);
 if(canonicalProofJson(value.command)===canonicalProofJson(sealed.command) && canonicalProofJson(value.args)===canonicalProofJson(sealed.args))return "cogni-node-app-v1+database-ca-v1";
 throw new Error("unsupported_command");
}
export function projectService(value:unknown) {
 const s=record(value);
 // No env, SDL, raw command or their hashes ever leave this private classification.
 if(s.env!==undefined)throw new Error("unavailable");
 const result=ProofServiceSchema.parse({name:s.name,artifact:s.artifact,runtimeProfile:s.runtimeProfile??"image-default",commandTemplate:commandTemplate(s),secretRefs:s.secretRefs??[],bindings:Object.entries(record(s.bindings??{})).map(([key,service])=>({key,service})),port:s.port,visibility:s.visibility,bindHost:s.bindHost,cpuUnits:s.cpuUnits,memoryMi:s.memoryMi,storageMi:s.storageMi});
 return result;
}
