/** Package only the value-first public deliverables. Preserve both previous editions. */
import assert from 'node:assert/strict';
import {copyFile,constants,lstat,mkdtemp,readFile} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {argumentsFor,hash,read,save,inventory,safeFile} from './goal016-media.mjs';
import {loadValueSources,resolveValueScenes} from './value-media.mjs';
export const EDITION='goal016-value-first';
const SHA=/^[a-f0-9]{64}$/;
const assertZero=(object,keys)=>{for(const key of keys)assert.equal(object[key],0);};
export const PUBLIC_FILES=[
 'README.txt','adopted-same-version.pdf','architecture-description.txt','architecture.png',
 'captions.srt','demo-full.mp4','demo-full-narrated.mp4','image-descriptions.txt',
 'images/01-select-your-art.png','images/02-describe-the-motion.png',
 'images/03-compare-the-ai-proposal.png','images/04-print-the-adopted-version.png',
 'narration-timed.txt','problem-solution.txt','review-instructions-public-note.txt',
 'youtube-audio-credit.txt','youtube-description.txt',
].sort();
const banned=/動作未確認|実物未検証|確認できていません|ローカル|別セッション|公開版で収録|実AIの実行記録|1依頼|1送信|追加AI|Goal\d|SHA|検証記録|監査/;
async function preservation(assets,path){
 const p=await read(path);assert.equal(p.files.length,751);
 assert.equal(new Set(p.files.map(x=>x.file)).size,p.files.length);
 for(const f of p.files){assert(!f.file.includes(EDITION));const file=await safeFile(assets,f.file);assert.equal((await lstat(file)).size,f.bytes);assert.equal(await hash(file),f.sha256);}
 return {files:p.files.length,manifestSha256:await hash(path),allExact:true};
}
export function validateReviews(edl,review,n,nr,accepted,binding){
 assert.equal(edl.edition,EDITION);assert(SHA.test(edl.sha256));
 assert(Number.isFinite(edl.durationSeconds)&&edl.durationSeconds>=150&&edl.durationSeconds<=180);
 assert.equal(edl.width,1920);assert.equal(edl.height,1080);assert.equal(edl.fps,25);
 assert.equal(edl.frames,Math.round(edl.durationSeconds*25));assert(Math.abs(edl.frames-edl.durationSeconds*25)<1e-6);
 assertZero(edl,['newCloudCalls','newModelCalls']);assert.equal(edl.sha256,binding.movieSha256);
 assert.equal(review.format,'ugoku-goal016-value-first-video-technical-v1');assert.equal(review.edition,EDITION);
 assert.equal(review.sha256,binding.movieSha256);assert.equal(review.edlSha256,binding.edlSha256);
 assert.equal(review.durationSeconds,edl.durationSeconds);assert.equal(review.totalFrames,edl.frames);
 assert.equal(review.result,'technical-pass-visual-review-pending');assert.equal(review.fullDecode,`passed-all${edl.frames}-frames-no-errors`);
 assert.equal(review.playback.ended,true);assert.equal(review.playback.playbackRate,1);assert.equal(review.playback.quality.corruptedVideoFrames,0);
 assert.equal(review.browserErrors.pageErrors.length+review.browserErrors.consoleErrors.length+review.browserErrors.blockedExternalRequests.length,0);
 assertZero(review,['cloudCalls','newModelCalls']);
 assert.equal(accepted.accepted,true);assert.equal(accepted.videoSha256,binding.movieSha256);assert(accepted.visual&&typeof accepted.visual==='object');
 if(review.playback.quality.droppedVideoFrames>0)assert.equal(accepted.visual.droppedFramesReviewed,true);
 assert.equal(n.format,'ugoku-local-nemo-narration-v1');assert.equal(n.edition,EDITION);
 assert.equal(n.sourceSha256,binding.movieSha256);assert.equal(n.edlSha256,binding.edlSha256);assert.equal(n.movieSha256,binding.narratedSha256);assert.equal(n.captureSha256,edl.captureSha256);
 assert.equal(n.durationSeconds,edl.durationSeconds);assert.equal(n.videoCodec,'copy');assertZero(n,['cloudCalls','externalSpeechApiCalls']);
 assert.equal(nr.format,'ugoku-goal016-value-first-narration-objective-review-v1');
 assert.equal(nr.result,'objective-pass-listening-not-verified');assert.equal(nr.source.sha256,binding.movieSha256);assert.equal(nr.movie.sha256,binding.narratedSha256);
 assert.equal(nr.manifest.sha256,binding.narrationManifestSha256);assert.equal(nr.videoPacketComparison.count,edl.frames);
 assert.deepEqual(nr.fullDecode,{original:'passed-all-video',narrated:'passed-all-video-and-audio'});
 assert.equal(nr.playback.ended,true);assert.equal(nr.playback.muted,false);assert.equal(nr.playback.volume,1);assert.equal(nr.playback.playbackRate,1);assert.equal(nr.playback.quality.corruptedVideoFrames,0);
 assert.equal(nr.browserErrors.pageErrors.length+nr.browserErrors.consoleErrors.length+nr.browserErrors.blockedExternalRequests.length,0);
 assertZero(nr,['cloudCalls','newModelCalls','audioGenerationCalls']);
 if(nr.playback.quality.droppedVideoFrames>0)assert.equal(accepted.visual.narrationDroppedFramesReviewed,true);
}


export async function main(options){
 assert(['stage','seal'].includes(options.mode));
 const assets=resolve(options['assets-root']), work=join(assets,'private',EDITION), out=join(assets,'public',EDITION);
 const preserved=await preservation(assets,join(work,'preservation.json'));
 const candidatePath=join(work,'package-candidate.json');
 const record=async file=>{const p=await safeFile(out,file);return {file,bytes:(await lstat(p)).size,sha256:await hash(p)};};
 if(options.mode==='seal'){
  const candidate=await read(candidatePath), scanPath=join(work,'secret-scan-attestation.json'),scan=await read(scanPath);
  assert.equal(scan.result,'passed');assert.equal(scan.candidateSha256,await hash(candidatePath));
  assert.equal(scan.knownCredentialByteScan,true);assert.equal(scan.secretValuesPrinted,false);assert.equal(scan.visualNoCredential,true);
  assert.deepEqual(scan.files,candidate.files);assert.deepEqual(candidate.files.map(f=>f.file),PUBLIC_FILES);
  assert.deepEqual(await inventory(out),PUBLIC_FILES);
  for(const f of candidate.files)assert.deepEqual(await record(f.file),f);
  const check=await mkdtemp(join(work,'zip-check-')),zip=join(assets,`ugoku-kami-${EDITION}.zip`);
  execFileSync('python3',['-c',`import pathlib,sys,zipfile
p,zp,ex=map(pathlib.Path,sys.argv[1:]); files=sorted(f for f in p.rglob('*') if f.is_file())
names=[p.name+'/'+f.relative_to(p).as_posix() for f in files]
with zipfile.ZipFile(zp,'x',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for f,n in zip(files,names): z.write(f,n)
with zipfile.ZipFile(zp) as z:
 assert z.namelist()==names and len(set(names))==17 and z.testzip() is None
 for n in names: assert not pathlib.PurePosixPath(n).is_absolute() and '..' not in pathlib.PurePosixPath(n).parts
 z.extractall(ex)
for f,n in zip(files,names): assert f.read_bytes()==(ex/n).read_bytes()
`,out,zip,check],{stdio:'pipe'});
  for(const f of candidate.files)assert.deepEqual(await record(f.file),f);
  await preservation(assets,join(work,'preservation.json'));
  const result={format:'ugoku-value-first-package-result-v1',zip:relative(assets,zip),sha256:await hash(zip),bytes:(await lstat(zip)).size,files:candidate.files,allZipFilesExtractedAndByteMatched:true,candidateSha256:await hash(candidatePath),secretScanSha256:await hash(scanPath),preservation:preserved,cloudCalls:0,newModelCalls:0};
  await save(join(work,'package-result.json'),result);
  console.log(JSON.stringify({status:'sealed',zip:result.zip,files:result.files.length}));return;
 }
 const edlPath=join(work,'video/edit-decisions.json'),edl=await read(edlPath);
 const sources=await loadValueSources(assets,edl.realCaptureManifest,edl.localCaptureManifest);
 await resolveValueScenes(edl,sources);
 const review=await read(join(work,'video/review/technical-review.json'));
 const nPath=join(work,'narration/output/manifest.json'),n=await read(nPath),nr=await read(join(work,'narration/review/technical-review.json'));
 const accepted=await read(join(work,'acceptance.json'));
 validateReviews(edl,review,n,nr,accepted,{
  movieSha256:await hash(join(out,'demo-full.mp4')),edlSha256:await hash(edlPath),
  narratedSha256:await hash(join(work,'narration/output/demo-full-narrated.mp4')),narrationManifestSha256:await hash(nPath),
 });
 const integration=await read(join(work,'integration-status.json'));
 assert(/^[a-f0-9]{40}$/.test(integration.mainSha));assert.equal(integration.pushed,true);
 assert.deepEqual(integration.ci.map(c=>c.name).sort(),['Check','WebKit representative workflow']);
 assert(integration.ci.every(c=>c.headSha===integration.mainSha&&c.status==='completed'&&c.conclusion==='success'));
 const staticProvenance=await read(join(work,'static/provenance.json'));
 assert.equal(staticProvenance.edition,EDITION);
 const expectedStatic=PUBLIC_FILES.filter(f=>!['captions.srt','demo-full.mp4','demo-full-narrated.mp4','narration-timed.txt','youtube-audio-credit.txt'].includes(f));
 assert.deepEqual(staticProvenance.files.map(f=>f.file).sort(),expectedStatic);
 for(const f of staticProvenance.files)assert.deepEqual(await record(f.file),f,'Reviewed static bytes changed before stage');
 assert.equal(await hash(join(out,'adopted-same-version.pdf')),sources.pdf.sha256);
 const roles={selection:'01-select-your-art.png',request:'02-describe-the-motion.png',comparison:'03-compare-the-ai-proposal.png',print:'04-print-the-adopted-version.png'};
 for(const im of sources.real.capture.images)assert.equal(await hash(join(out,'images',roles[im.role])),im.sha256);
 for(const file of ['demo-full-narrated.mp4','narration-timed.txt','youtube-audio-credit.txt'])await copyFile(join(work,'narration/output',file),join(out,file),constants.COPYFILE_EXCL);
 assert.deepEqual(await inventory(out),PUBLIC_FILES);
 for(const file of PUBLIC_FILES.filter(f=>/\.(txt|srt)$/.test(f))){
  const text=await readFile(join(out,file),'utf8');assert(text.trim());
  assert(!banned.test(text),`Production commentary in public ${file}`);
 }
 for(const file of ['problem-solution.txt','architecture-description.txt'])assert([...await readFile(join(out,file),'utf8')].length<=800);
 assert((await readFile(join(out,'youtube-description.txt'),'utf8')).includes('音声：VOICEVOX Nemo（女声1）'));
 const files=await Promise.all(PUBLIC_FILES.map(record));
 await preservation(assets,join(work,'preservation.json'));
 await save(candidatePath,{format:'ugoku-value-first-package-candidate-v1',files,preservation:preserved});
 await save(join(work,'manifest.json'),{format:'ugoku-value-first-private-materials-v1',edition:EDITION,files,
  source:{real:edl.realCaptureManifest,sha256:edl.captureSha256,local:edl.localCaptureManifest,localSha256:edl.localCaptureSha256},
  video:{sha256:edl.sha256,narratedSha256:n.movieSha256,durationSeconds:edl.durationSeconds,frames:edl.frames,edlSha256:await hash(edlPath)},
  adopted:sources.pdf.stamp,pdfSha256:sources.pdf.sha256,mainIntegration:integration,preservation:preserved,
  limitations:{subjectiveListening:'not-verified',physicalValidation:'unverified'},newModelCalls:0,cloudCalls:0,appChanges:0,redeploys:0,youtubePosted:false,zennSubmitted:false});
 console.log(JSON.stringify({status:'staged-awaiting-root-secret-scan',files:files.length}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main(argumentsFor(process.argv.slice(2),['assets-root','mode']));
