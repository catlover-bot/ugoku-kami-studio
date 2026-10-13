/** Ingest a completed NEW actual public workflow. Does not open a browser or API. */
import assert from 'node:assert/strict';
import {mkdir,copyFile,constants} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {EDITION,IMAGE_NAMES,argumentsFor,loadCapture,save,within} from './goal016-media.mjs';
const args=argumentsFor(process.argv.slice(2),['assets-root','capture']);
const assets=resolve(args['assets-root']),evidence=await loadCapture(assets,args.capture);
const out=join(assets,'public',EDITION),work=join(assets,'private',EDITION);
await mkdir(out,{recursive:true});await mkdir(work,{recursive:true,mode:0o700});
await mkdir(join(out,'images')); // A previous intake is never replaced.
for(const image of evidence.capture.images)await copyFile(within(evidence.directory,image.file),join(out,'images',IMAGE_NAMES[image.role]),constants.COPYFILE_EXCL);
await copyFile(within(evidence.directory,evidence.capture.pdf.file),join(out,'adopted-same-version.pdf'),constants.COPYFILE_EXCL);
assert.equal(evidence.capture.newModelRequests,1);
await save(join(work,'capture-intake.json'),{format:'ugoku-goal016-intake-v1',createdAt:new Date().toISOString(),capture:relative(assets,evidence.path),captureSha256:evidence.sha256,sourceSha:evidence.capture.sourceSha,revision:evidence.capture.revision,liveAi:evidence.capture.liveAi,images:evidence.capture.images.map(i=>({file:`images/${IMAGE_NAMES[i.role]}`,source:relative(assets,within(evidence.directory,i.file)),sha256:i.sha256,stamp:i.stamp,role:i.role})),pdf:{...evidence.capture.pdf,file:'adopted-same-version.pdf'},newCloudCalls:0,newModelCalls:0,note:'File ingestion only. The recorded workflow contains the separately authorized one real request.'});
console.log(JSON.stringify({status:'new-capture-verified',captureSha256:evidence.sha256,sourceSha:evidence.capture.sourceSha,images:4,pdfPages:evidence.capture.pdf.pages,newModelCalls:0}));
