// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { computeProofHash, parseComputeProof } from "./request";
export const requestFixture = () => ({version:1,nonce:"a".repeat(64),expected:{nodeId:"4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",repository:"cogni-dao/cogni",environment:"candidate-a",sourceSha:"b".repeat(40),deploySha:"c".repeat(40),bundleRef:`ghcr.io/cogni/bundle@sha256:${"d".repeat(64)}`,workloads:[{instance:null,kind:"XComputeWorkload",publicHost:"test.cognidao.org",leaseGeneration:0,artifacts:[{name:"app",image:`ghcr.io/cogni/app@sha256:${"e".repeat(64)}`}],services:[{name:"app",artifact:"app",runtimeProfile:"cogni-node-app-v1",commandTemplate:"image-default",secretRefs:[],bindings:[],port:3000,visibility:"public",bindHost:"0.0.0.0",cpuUnits:100,memoryMi:256,storageMi:1}]}]}});
describe("comparative proof boundary",()=>{
 it("rejects every private input before any IO",()=>{
  for(const key of ["env","sdl","command","sql","namespace","url","leaseId","selector","logs"]){
   const value=requestFixture();Object.assign(value.expected.workloads[0]?.services[0]??{}, {[key]:"private"});
   expect(()=>parseComputeProof(JSON.stringify(value))).toThrow();
  }
 });
 it("binds all parsed fields and nonce, including tuple and ordered arrays",()=>{
  const value=parseComputeProof(JSON.stringify(requestFixture())); const hash=computeProofHash(value);
  for(const change of [(x:typeof value)=>{x.nonce="f".repeat(64)},(x:typeof value)=>{x.expected.deploySha="f".repeat(40)},(x:typeof value)=>{if(x.expected.workloads[0])x.expected.workloads[0].leaseGeneration=1},(x:typeof value)=>{const s=x.expected.workloads[0]?.services[0];if(s)s.memoryMi=512}]){const x=structuredClone(value);change(x);expect(computeProofHash(x)).not.toBe(hash)}
 });
 it("rejects unknown fields, duplicates, empty/unbound and oversized inventory",()=>{
  const value=requestFixture();value.expected.workloads.push(value.expected.workloads[0]!);
  expect(()=>parseComputeProof(JSON.stringify(value))).toThrow();
  expect(()=>parseComputeProof(" ".repeat(65537))).toThrow();
 });
});
