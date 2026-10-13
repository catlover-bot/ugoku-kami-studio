/** Goal016 evidence guards. Local files only; never starts the app or a model. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,readdir,lstat,realpath} from 'node:fs/promises';
import {resolve,relative,join,sep,isAbsolute} from 'node:path';
import {PDFDocument} from 'pdf-lib';

export const EDITION='goal016-final';
export const IMAGE_NAMES={selection:'01-select-your-art.png',request:'02-describe-the-motion.png',comparison:'03-compare-the-ai-proposal.png',print:'04-print-the-adopted-version.png'};
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const hash=async path=>sha(await readFile(path));
export const read=async path=>JSON.parse(await readFile(path,'utf8'));
export const save=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
export function argumentsFor(args,required,optional=[]){
 assert.equal(args.length%2,0);const values={};
 for(let i=0;i<args.length;i+=2){const key=args[i].replace(/^--/,'');assert(args[i].startsWith('--')&&[...required,...optional].includes(key)&&!Object.hasOwn(values,key),'Unknown/duplicate argument');assert(args[i+1]&&!args[i+1].startsWith('--'));values[key]=args[i+1];}
 for(const key of required)assert(values[key],`Missing --${key}`);return values;
}
export function within(root,name){
 assert(typeof name==='string'&&name.length>0&&!name.includes('\0'));
 const path=resolve(root,name),rel=relative(resolve(root),path);
 assert(rel&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel),'Path must remain beneath the specified directory');return path;
}
export async function safeFile(root,name){
 const path=within(root,name);assert((await lstat(path)).isFile(),'Regular non-symlink file required');
 assert.equal(await realpath(path),path,'Symlinked ancestors are not accepted');return path;
}
export async function inventory(root){
 const result=[];
 async function visit(dir){for(const item of await readdir(dir,{withFileTypes:true})){const path=join(dir,item.name);assert(!item.isSymbolicLink(),'No symlinks in a package');if(item.isDirectory())await visit(path);else{assert(item.isFile());result.push(relative(root,path));}}}
 await visit(root);return result.sort();
}
export function stamp(document){
 const result=Object.fromEntries(['designId','revision','designHash'].map(key=>[key,document?.[key]]));
 assert(typeof result.designId==='string'&&result.designId.length>0);assert(Number.isInteger(result.revision)&&result.revision>0);assert(/^[a-f0-9]{64}$/.test(result.designHash));return result;
}
export function validateCaptureShape(capture){
 assert.equal(capture.format,'ugoku-goal016-capture-v1');assert.equal(capture.status,'passed');
 assert(/^[a-f0-9]{40}$/.test(capture.sourceSha));assert(/^[a-f0-9]{64}$/.test(capture.imageDigest?.replace(/^sha256:/,'')));
 assert(typeof capture.revision==='string'&&capture.revision.length>0);assert(Number.isFinite(Date.parse(capture.capturedAt)));
 const origin=new URL(capture.publicOrigin);assert.equal(origin.protocol,'https:');assert.equal(origin.origin,capture.publicOrigin);assert(!origin.username&&!origin.password);
 assert.equal(capture.newModelRequests,1);const ai=capture.liveAi;assert.equal(ai?.provider,'vertex');assert.equal(ai.status,'adopted');
 assert(Number.isInteger(ai.modelCalls)&&ai.modelCalls>=1&&ai.modelCalls<=6);assert(['exact','alternative'].includes(ai.proposalKind));
 assert(typeof ai.requestId==='string'&&typeof ai.runId==='string');assert(Number.isFinite(ai.requestedMm)&&Number.isFinite(ai.adoptedMm));
 const before=stamp(ai.before),adopted=stamp(ai.adopted);assert.equal(adopted.designId,before.designId);assert.equal(adopted.revision,before.revision+1);assert.notEqual(adopted.designHash,before.designHash);
 if(ai.proposalKind==='exact')assert.equal(ai.requestedMm,ai.adoptedMm);
 for(const key of ['realProvider','approval','sameVersionPdf','guide','savedReload','publicIntervalsExcludeSettings'])assert.equal(capture.checks?.[key],true,`Missing ${key} evidence`);
 assert.equal(capture.physicalValidation,'unverified');assert(capture.frontendAssets?.length>0);
 assert(Array.isArray(capture.clips)&&capture.clips.length>0);const clipIds=new Set();
 for(const c of capture.clips){assert(/^[a-z0-9-]+$/.test(c.id)&&!clipIds.has(c.id));clipIds.add(c.id);assert.equal(c.role,'live-workflow');assert.equal(c.sourceSha,capture.sourceSha);assert.equal(c.credentialFree,true);assert(Number.isFinite(c.usableStartSeconds)&&Number.isFinite(c.usableEndSeconds)&&c.usableStartSeconds>=0&&c.usableEndSeconds>c.usableStartSeconds);}
 assert.equal(capture.images?.length,4);assert.deepEqual(capture.images.map(i=>i.role).sort(),Object.keys(IMAGE_NAMES).sort());
 for(const image of capture.images){const s=stamp(image.stamp);assert.equal(s.designId,before.designId);if(image.role==='print')assert.deepEqual(s,adopted);if(['request','comparison'].includes(image.role))assert.deepEqual(s,before);}
 assert.deepEqual(stamp(capture.pdf?.stamp),adopted);assert.equal(capture.pdf.A4,true);assert(Number.isInteger(capture.pdf.pages)&&capture.pdf.pages>0);
 return capture;
}
export async function loadCapture(assets,manifest){
 const root=resolve(assets,'private',EDITION,'capture');const path=await safeFile(root,relative(root,resolve(manifest))),directory=resolve(path,'..');
 const capture=validateCaptureShape(await read(path));
 const files=[...capture.clips,...capture.images,capture.pdf,...Object.values(capture.evidence??{})];
 for(const item of files){assert(item&&/^[a-f0-9]{64}$/.test(item.sha256));const file=await safeFile(directory,item.file);assert.equal(await hash(file),item.sha256,`Capture file changed: ${item.file}`);}
 for(const key of ['runFinal','adoptedProject','events'])assert(capture.evidence?.[key]);
 const run=await read(within(directory,capture.evidence.runFinal.file)),project=await read(within(directory,capture.evidence.adoptedProject.file));
 assert.equal(run.id,capture.liveAi.runId);assert.equal(run.requestId,capture.liveAi.requestId);assert.equal(run.provider,'vertex');assert.equal(run.mode,'vertex');assert.equal(run.status,'succeeded');assert.equal(run.modelCalls,capture.liveAi.modelCalls);
 assert(run.modelUsage?.some(call=>call.received===true),'Actual model response evidence required');
 assert.deepEqual(stamp(project.document),stamp(capture.liveAi.adopted));
 assert.deepEqual(stamp(run.proposal?.document),stamp(capture.liveAi.adopted));
 assert.equal(run.proposal.fulfillsRequested,capture.liveAi.proposalKind==='exact');
 const pdf=await PDFDocument.load(await readFile(within(directory,capture.pdf.file)),{updateMetadata:false});
 assert.equal(pdf.getTitle(),`${capture.liveAi.adopted.designId} revision ${capture.liveAi.adopted.revision}`);assert(pdf.getSubject()?.includes(capture.liveAi.adopted.designHash));assert(pdf.getSubject()?.includes('physically unverified'));assert.equal(pdf.getPageCount(),capture.pdf.pages);
 for(const p of pdf.getPages()){const s=p.getSize();assert(Math.abs(s.width*25.4/72-210)<1e-5&&Math.abs(s.height*25.4/72-297)<1e-5);}
 return {capture,path,directory,sha256:await hash(path)};
}
/** Every moving scene references a bound interval, never an arbitrary old file. */
export function validateScenes(scenes,capture){
 assert(Array.isArray(scenes)&&scenes.length>=3);const ids=new Set();
 for(const scene of scenes){
  assert(/^[a-z0-9-]+$/.test(scene.id)&&!ids.has(scene.id));ids.add(scene.id);
  assert(['video','still'].includes(scene.kind));assert(Number.isFinite(scene.duration)&&scene.duration>0&&Math.abs(scene.duration*25-Math.round(scene.duration*25))<1e-6);
  assert(typeof scene.caption==='string'&&scene.caption.length>0&&typeof scene.label==='string'&&scene.label.length>0);
  assert(!/旧UI|更新前|過去の実|模擬|mock|injected/i.test(scene.label+' '+scene.caption),'This edition contains only the new real workflow');
  if(scene.kind==='video'){
   const clip=capture.clips.find(c=>c.id===scene.clipId);assert(clip,'Unknown/unbound clip');assert.equal(scene.playbackRate,1);
   assert(Number.isFinite(scene.sourceStart)&&scene.sourceStart>=clip.usableStartSeconds&&scene.sourceStart+scene.duration<=clip.usableEndSeconds+1e-6,'Cut leaves the credential-free interval');
  }else{assert(capture.images.some(i=>i.role===scene.imageRole));assert(scene.duration<=5);assert(scene.label.includes('静止'),'Frozen screenshots must be labeled');}
 }
 return scenes;
}
export async function verifyPreservation(assets,manifest){
 const data=await read(manifest);assert(Array.isArray(data.materials)&&data.materials.length>0);
 for(const f of data.materials){assert(f.path.startsWith('artifacts/submission/'));const name=f.path.slice('artifacts/submission/'.length);assert(!name.startsWith(`public/${EDITION}/`));const p=await safeFile(assets,name);assert.equal((await lstat(p)).size,f.bytes);assert.equal(await hash(p),f.sha256,`Preserved asset changed: ${f.path}`);}
 return {file:relative(assets,manifest),sha256:await hash(manifest),fileCount:data.materials.length,unchanged:true};
}
