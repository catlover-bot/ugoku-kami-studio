/** Pure synthetic boundary checks. This does not create model evidence or media. */
import assert from 'node:assert/strict';
import {validateCaptureShape,validateScenes,within} from './goal016-media.mjs';
const before={designId:'offline-fixture',revision:1,designHash:'a'.repeat(64)},adopted={...before,revision:2,designHash:'b'.repeat(64)};
const fixture={format:'ugoku-goal016-capture-v1',status:'passed',sourceSha:'c'.repeat(40),imageDigest:'sha256:'+'d'.repeat(64),revision:'offline-fixture-revision',capturedAt:'2026-10-14T00:00:00.000Z',publicOrigin:'https://fixture.invalid',newModelRequests:1,liveAi:{provider:'vertex',status:'adopted',requestId:'fixture-request',runId:'fixture-run',modelCalls:2,proposalKind:'exact',requestedMm:25,adoptedMm:25,before,adopted},checks:Object.fromEntries(['realProvider','approval','sameVersionPdf','guide','savedReload','publicIntervalsExcludeSettings'].map(k=>[k,true])),physicalValidation:'unverified',frontendAssets:[{file:'index.js',sha256:'e'.repeat(64)}],clips:[{id:'workflow',role:'live-workflow',sourceSha:'c'.repeat(40),credentialFree:true,usableStartSeconds:10,usableEndSeconds:100}],images:['selection','request','comparison','print'].map(role=>({role,stamp:role==='print'?adopted:before})),pdf:{stamp:adopted,A4:true,pages:5}};
assert.equal(validateCaptureShape(fixture),fixture);
let rejected=0;
for(const mutate of [c=>{c.liveAi.provider='injected-test';},c=>{c.newModelRequests=2;},c=>{c.liveAi.modelCalls=0;},c=>{c.images[2].stamp=adopted;},c=>{c.pdf.stamp=before;},c=>{c.checks.publicIntervalsExcludeSettings=false;}]){const c=structuredClone(fixture);mutate(c);assert.throws(()=>validateCaptureShape(c));rejected++;}
const scenes=[0,1,2].map(i=>({id:'scene-'+i,kind:'video',clipId:'workflow',sourceStart:10+i*10,duration:10,playbackRate:1,label:'実AIの新収録',caption:'現在と候補を比較する。'}));
validateScenes(scenes,fixture);
for(const mutate of [s=>{s[0].sourceStart=9.96;},s=>{s[0].clipId='historical';},s=>{s[0].playbackRate=2;},s=>{s[2].sourceStart=95;},s=>{s[0].label='UI更新前の実行記録';}]){const s=structuredClone(scenes);mutate(s);assert.throws(()=>validateScenes(s,fixture));rejected++;}
assert.throws(()=>within('/tmp/goal016','../goal014/raw.webm'));rejected++;
console.log(JSON.stringify({result:'passed',kind:'synthetic-offline-boundary-checks',validCases:2,rejectedCases:rejected,cloudCalls:0,modelCalls:0,mediaGenerated:0}));
