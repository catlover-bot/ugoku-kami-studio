/** Offline, exclusive stage/seal for the 150–180 second submission film.
 * Stage never reads credential values as text. Seal requires a separate root scan.
 * Earlier artifacts, including private files, are read only as bytes for preservation.
 */
import assert from 'node:assert/strict';
import {access,copyFile,constants,lstat,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {argumentsFor,hash,read,save,inventory,safeFile,loadCapture} from './goal016-media.mjs';

export const EDITION='goal016-submission';
export const STATIC_FILES=[
 'adopted-same-version.pdf','architecture-description.txt','architecture.png',
 'images/01-select-your-art.png','images/02-describe-the-motion.png',
 'images/03-compare-the-ai-proposal.png','images/04-print-the-adopted-version.png',
 'problem-solution.txt','review-instructions-public-note.txt',
].sort();
export const PUBLIC_FILES=[...STATIC_FILES,'README.txt','manifest.json','captions.srt',
 'demo-full.mp4','demo-full-narrated.mp4','narration-timed.txt','youtube-audio-credit.txt'].sort();
const OLD_EDITION='goal016-final';
const SHA=/^[a-f0-9]{64}$/;
const exists=p=>access(p).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
const assertZero=(object,keys)=>{for(const key of keys)assert.equal(object[key],0,`Expected ${key}=0`);};

export function validatePreservationRecords(p){
 assert.equal(p.format,'ugoku-goal016-submission-preservation-v1');
 assert.equal(p.files.length,164,'The original 164-file snapshot is required');
 assert.equal(p.files.reduce((n,f)=>n+f.bytes,0),61_440_209);
 assert.equal(p.mainBefore,'dff775924b2f50ab0eb5695594d49fd1e8aba915');
 assert.equal(p.publicAppSha,'6c1b858bbe73542d179334b84ef4aefe57de65aa');
 const names=new Set();
 for(const f of p.files){
  assert(typeof f.file==='string'&&f.file.length>0&&!f.file.startsWith('/')&&!f.file.includes('\\')&&!f.file.split('/').some(v=>!v||v==='.'||v==='..'));
  assert(!names.has(f.file),'Duplicate preservation entry');names.add(f.file);
  assert(!f.file.startsWith(`public/${EDITION}/`)&&!f.file.startsWith(`private/${EDITION}/`),'New output must not be in the old snapshot');
  assert(SHA.test(f.sha256)&&Number.isSafeInteger(f.bytes)&&f.bytes>=0);
 }
 assert(names.has(`public/${OLD_EDITION}/manifest.json`));
 assert(names.has(`private/${OLD_EDITION}/reviewer-instructions.txt`));
 return p.files;
}

export async function verifyPreservation(assets,file){
 const records=validatePreservationRecords(await read(file));
 for(const f of records){const path=await safeFile(assets,f.file);assert.equal((await lstat(path)).size,f.bytes,'Earlier artifact size changed');assert.equal(await hash(path),f.sha256,'Earlier artifact hash changed');}
 return {manifestSha256:await hash(file),files:records.length,bytes:records.reduce((n,f)=>n+f.bytes,0),allExact:true,credentialValuesParsedOrPrinted:false};
}

export function validateReviews(edl,review,n,nr,accepted,binding){
 assert.equal(edl.edition,EDITION);assert(SHA.test(edl.sha256));
 assert(Number.isFinite(edl.durationSeconds)&&edl.durationSeconds>=150&&edl.durationSeconds<=180);
 assert.equal(edl.width,1920);assert.equal(edl.height,1080);assert.equal(edl.fps,25);
 assert.equal(edl.frames,Math.round(edl.durationSeconds*25));assert(Math.abs(edl.frames-edl.durationSeconds*25)<1e-6);
 assertZero(edl,['newCloudCalls','newModelCalls']);assert.equal(edl.sha256,binding.movieSha256);
 assert.equal(review.format,'ugoku-goal016-submission-video-technical-v1');assert.equal(review.edition,EDITION);
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
 assert.equal(nr.format,'ugoku-goal016-submission-narration-objective-review-v1');
 assert.equal(nr.result,'objective-pass-listening-not-verified');assert.equal(nr.source.sha256,binding.movieSha256);assert.equal(nr.movie.sha256,binding.narratedSha256);
 assert.equal(nr.manifest.sha256,binding.narrationManifestSha256);assert.equal(nr.videoPacketComparison.count,edl.frames);
 assert.deepEqual(nr.fullDecode,{original:'passed-all-video',narrated:'passed-all-video-and-audio'});
 assert.equal(nr.playback.ended,true);assert.equal(nr.playback.muted,false);assert.equal(nr.playback.volume,1);assert.equal(nr.playback.playbackRate,1);assert.equal(nr.playback.quality.corruptedVideoFrames,0);
 assert.equal(nr.browserErrors.pageErrors.length+nr.browserErrors.consoleErrors.length+nr.browserErrors.blockedExternalRequests.length,0);
 assertZero(nr,['cloudCalls','newModelCalls','audioGenerationCalls']);
 if(nr.playback.quality.droppedVideoFrames>0)assert.equal(accepted.visual.narrationDroppedFramesReviewed,true);
}

export function validateScan(candidate,scan,candidateSha256){
 assert.equal(candidate.format,'ugoku-goal016-submission-package-candidate-v1');
 assert.deepEqual(candidate.files.map(f=>f.file),PUBLIC_FILES);
 assert.equal(scan.format,'ugoku-goal016-submission-secret-scan-v1');assert.equal(scan.result,'passed');assert.equal(scan.candidateSha256,candidateSha256);
 assert.equal(scan.knownCredentialByteScan,true);assert.equal(scan.secretValuesPrinted,false);assert.equal(scan.visualNoCredential,true);
 assert.deepEqual(scan.files,candidate.files,'Scan must cover the exact candidate byte/hash records in the same order');
}

export async function main(options){
 assert(['stage','seal'].includes(options.mode));
 const assets=resolve(options['assets-root']),work=join(assets,'private',EDITION),out=join(assets,'public',EDITION),old=join(assets,'public',OLD_EDITION);
 const preservationFile=join(work,'preservation.json'),preserved=await verifyPreservation(assets,preservationFile);
 const fileRecord=async file=>{const path=await safeFile(out,file);return {file,bytes:(await lstat(path)).size,sha256:await hash(path)};};
 const candidatePath=join(work,'package-candidate.json'),scanPath=join(work,'secret-scan-attestation.json');
 if(options.mode==='seal'){
  const candidate=await read(candidatePath),scan=await read(scanPath);validateScan(candidate,scan,await hash(candidatePath));
  assert.deepEqual(await inventory(out),PUBLIC_FILES);
  for(const f of candidate.files)assert.deepEqual(await fileRecord(f.file),f,'Public candidate changed after scan');
  const stage=await mkdtemp(join(work,'zip-check-')),zip=join(assets,`ugoku-kami-${EDITION}.zip`),extracted=join(stage,'extracted');
  execFileSync('python3',['-c',`import pathlib,sys,zipfile
p=pathlib.Path(sys.argv[1]); zp=pathlib.Path(sys.argv[2]); extracted=pathlib.Path(sys.argv[3])
files=sorted(f for f in p.rglob('*') if f.is_file()); names=[p.name+'/'+f.relative_to(p).as_posix() for f in files]
with zipfile.ZipFile(zp,'x',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for f,name in zip(files,names): z.write(f,name)
with zipfile.ZipFile(zp) as z:
 assert z.namelist()==names and len(set(names))==16 and z.testzip() is None
 for info in z.infolist():
  assert not pathlib.PurePosixPath(info.filename).is_absolute() and '..' not in pathlib.PurePosixPath(info.filename).parts
 z.extractall(extracted)
for f,name in zip(files,names): assert f.read_bytes()==(extracted/name).read_bytes()
`,out,zip,extracted],{stdio:'pipe'});
  for(const f of candidate.files)assert.deepEqual(await fileRecord(f.file),f,'Public candidate changed during ZIP creation');
  await verifyPreservation(assets,preservationFile);
  const result={format:'ugoku-goal016-submission-package-result-v1',sealedAt:new Date().toISOString(),zip:relative(assets,zip),sha256:await hash(zip),bytes:(await lstat(zip)).size,files:candidate.files,candidateSha256:await hash(candidatePath),secretScanSha256:await hash(scanPath),allZipFilesExtractedAndByteMatched:true,preservation:preserved,cloudCalls:0,newModelCalls:0,credentialValuesParsedOrPrinted:false};
  await save(join(work,'package-result.json'),result);console.log(JSON.stringify({status:'sealed',zip:result.zip,sha256:result.sha256,files:result.files.length}));return;
 }
 assert(!await exists(candidatePath),'An existing edition must be preserved; no implicit replacement');
 assert.deepEqual(await inventory(out),['captions.srt','demo-full.mp4'],'Only the new renderer outputs may precede stage');
 const oldManifestFile=await safeFile(old,'manifest.json'),oldManifest=await read(oldManifestFile);
 assert.equal(oldManifest.edition,OLD_EDITION);assert.equal(oldManifest.format,'ugoku-goal016-public-materials-v1');
 const evidence=await loadCapture(assets,join(assets,oldManifest.capture.file)),capture=evidence.capture;
 assert.equal(evidence.sha256,oldManifest.capture.sha256);assert.equal(capture.newModelRequests,1);assert.equal(capture.liveAi.modelCalls,1);
 assert.equal(capture.liveAi.adoptedMm,25);assert.equal(capture.liveAi.adopted.revision,2);
 const edlPath=join(work,'video/edit-decisions.json'),edl=await read(edlPath);
 assert.equal(edl.captureSha256,evidence.sha256);assert.equal(edl.captureSourceSha,capture.sourceSha);
 assert.equal(resolve(assets,edl.realCaptureManifest),evidence.path);
 const localPath=await safeFile(assets,edl.localCaptureManifest),local=await read(localPath);
 assert.equal(resolve(assets,edl.localCaptureDirectory,'capture.json'),localPath);
 assert.equal(await hash(localPath),edl.localCaptureSha256);assert.equal(local.format,'ugoku-goal016-local-continuation-v1');assert.equal(local.status,'passed');
 assert.equal(local.rehearsal,false);assert.equal(local.submissionFootage,true);assert.equal(local.aiProvider,'none');
 assertZero(local,['newModelRequests','newModelCalls','aiCalls','cloudCalls']);assert.equal(local.originalCaptureSha256,evidence.sha256);assert.deepEqual(local.adopted,capture.liveAi.adopted);
 const {loadFullSources,resolveFullScenes}=await import('./full-media.mjs');
 const sources=await loadFullSources(assets,evidence.path,localPath),scenes=await resolveFullScenes(edl,sources);
 assert.equal(scenes.length,edl.scenes.length);
 for(const [i,s]of scenes.entries()){const e=edl.scenes[i];assert.equal(resolve(s.input),resolve(e.input));assert.equal(s.sourceSha256,e.sourceSha256);assert.equal(s.provenance,e.provenance);assert.equal(await hash(s.input),s.sourceSha256);}
 const reviewPath=join(work,'video/review/technical-review.json'),review=await read(reviewPath),acceptedPath=join(work,'acceptance.json'),accepted=await read(acceptedPath);
 const nPath=join(work,'narration/output/manifest.json'),n=await read(nPath),nrPath=join(work,'narration/review/technical-review.json'),nr=await read(nrPath);
 const binding={movieSha256:await hash(join(out,'demo-full.mp4')),edlSha256:await hash(edlPath),narratedSha256:await hash(join(work,'narration/output/demo-full-narrated.mp4')),narrationManifestSha256:await hash(nPath)};
 validateReviews(edl,review,n,nr,accepted,binding);
 const copied=[];
 for(const file of STATIC_FILES){const record=oldManifest.files.find(f=>f.file===file);assert(record,'Static file missing from original manifest');const path=await safeFile(old,file);assert.equal((await lstat(path)).size,record.bytes);assert.equal(await hash(path),record.sha256);copied.push(record);}
 assert.equal(copied.find(f=>f.file==='adopted-same-version.pdf').sha256,capture.pdf.sha256);
 for(const image of capture.images){const file=`images/${({selection:'01-select-your-art.png',request:'02-describe-the-motion.png',comparison:'03-compare-the-ai-proposal.png',print:'04-print-the-adopted-version.png'})[image.role]}`;assert.equal(copied.find(f=>f.file===file)?.sha256,image.sha256);}
 const textCounts={};
 for(const file of ['problem-solution.txt','architecture-description.txt']){const content=(await readFile(await safeFile(old,file),'utf8')).trimEnd();assert(content.trim());textCounts[file]={codePoints:[...content].length,utf16:content.length};assert(textCounts[file].codePoints<=800&&textCounts[file].utf16<=800);}
 const integrationPath=join(work,'integration-status.json');let mainIntegration=null;
 if(await exists(integrationPath)){mainIntegration=await read(integrationPath);assert(/^[a-f0-9]{40}$/.test(mainIntegration.mainSha));assert.equal(mainIntegration.pushed,true);assert.deepEqual(mainIntegration.ci.map(x=>x.name).sort(),['Check','WebKit representative workflow']);assert(mainIntegration.ci.every(x=>x.headSha===mainIntegration.mainSha&&x.status==='completed'&&x.conclusion==='success'));}
 await mkdir(join(out,'images'),{recursive:true});
 for(const f of copied)await copyFile(join(old,f.file),join(out,f.file),constants.COPYFILE_EXCL);
 for(const file of ['demo-full-narrated.mp4','narration-timed.txt','youtube-audio-credit.txt'])await copyFile(join(work,'narration/output',file),join(out,file),constants.COPYFILE_EXCL);
 const lines=[
  'YouTubeへ投稿する動画：demo-full-narrated.mp4',
  'うごく紙工房 — Goal016 提出用本編','',
  `保存先：artifacts/submission/public/${EDITION}/`,
  `ZIP：artifacts/submission/ugoku-kami-${EDITION}.zip`,
  `公開アプリ：${capture.publicOrigin}`,'',
  `動画：${edl.durationSeconds.toFixed(2)}秒 / 1920×1080 / 25fps / ${edl.frames}フレーム。demo-full.mp4は無音の同一映像です。`,
  '既存の実AI記録と、同じ採用設計を開く新しいローカル手動セッションを編集しています。別セッションへの切替と静止画は画面で区別します。',
  `実AIの出所：${capture.capturedAt}の公開UI、1依頼・モデル送信1回。20mmから25mmへの候補を比較して第2版へ採用した実録です。`,
  `実AI収録アプリsource：${capture.sourceSha} / revision：${capture.revision}`,
  '追加の手動収録はAI_PROVIDER=none。採用済みの同じ25mm・第2版を開き、印刷・ガイド・保存再開を操作しました。この本編制作に伴う新しいAI送信・Cloud操作は0です。','',
  '画像4枚・同版PDF・構成図・紹介文2欄・公開手順はgoal016-finalから同じバイトで継承しました。',
  ...STATIC_FILES.map(file=>`・${file}`),
  `PDF：A4 ${capture.pdf.pages}ページ / 第${capture.pdf.stamp.revision}版 / 設計hash ${capture.pdf.stamp.designHash}`,
  '型紙と実画面の版一致は確認済みですが、実物の印刷・組立・紙の動作は未確認です。',
  '設定画面・審査用コード・認証情報・私的ログは公開ファイルに含めません。','',
  n.credit,
  '音声はローカルVOICEVOX Nemo。YouTube説明欄にもyoutube-audio-credit.txtのクレジットを記載してください。',
  '利用条件：https://voicevox.hiroshiba.jp/nemo/term/',
  '映像の全編デコード・等速再生、抽出画面の目視と音声の客観検査を行いました。助手による耳での聴感確認は未実施です。',
  '36.08秒のgoal016-finalは履歴ダイジェストとして保全しています。Goal014/015の旧素材も変更していません。',
  'YouTubeへの投稿とZennへの最終提出は未実施です。未提出は本人確認済みです。',
  mainIntegration?`制作コードmain：${mainIntegration.mainSha}（同SHA CI成功）。配信・実AI収録SHAとは区別します。`:'制作コードの最終main統合・CIは別の引継ぎ記録を参照してください。配信・実AI収録SHAへ付け替えません。','',
 ];
 await writeFile(join(out,'README.txt'),lines.join('\n'),{flag:'wx'});
 const beforeManifest=PUBLIC_FILES.filter(file=>file!=='manifest.json');assert.deepEqual(await inventory(out),beforeManifest);
 const files=await Promise.all(beforeManifest.map(fileRecord));
 const manifest={format:'ugoku-goal016-submission-public-materials-v1',edition:EDITION,createdAt:new Date().toISOString(),status:'LOCAL_DRAFT_REVIEWED',primaryVideo:'demo-full-narrated.mp4',publicAppUrl:capture.publicOrigin,
  inherited:{edition:OLD_EDITION,manifestSha256:await hash(oldManifestFile),files:copied,exactCopy:true},
  realAiSource:{captureSha256:evidence.sha256,capturedAt:capture.capturedAt,sourceSha:capture.sourceSha,revision:capture.revision,imageDigest:capture.imageDigest,liveAi:capture.liveAi,requests:1,modelCalls:1},
  localContinuation:{captureSha256:edl.localCaptureSha256,sourceSha:local.sourceSha,adopted:local.adopted,aiProvider:'none',newModelRequests:0,newModelCalls:0,cloudCalls:0,separateSession:true},
  images:oldManifest.images,pdf:oldManifest.pdf,architecture:oldManifest.architecture,textCounts,
  video:{file:'demo-full.mp4',sha256:binding.movieSha256,durationSeconds:edl.durationSeconds,width:1920,height:1080,fps:25,frames:edl.frames,edlSha256:binding.edlSha256,
   scenes:edl.scenes.map(s=>({id:s.id,kind:s.kind,outputStart:s.outputStart,outputEnd:s.outputEnd,provenance:s.provenance,sourceSha256:s.sourceSha256}))},
  narration:{file:'demo-full-narrated.mp4',sha256:binding.narratedSha256,credit:n.credit,engineVersion:n.engineVersion,voice:n.voice,sourceVideoSha256:binding.movieSha256,videoPacketsUnchanged:true,objectiveReviewSha256:await hash(nrPath),subjectiveListening:'not-verified',conditionsUrl:'https://voicevox.hiroshiba.jp/nemo/term/'},
  review:{technicalSha256:await hash(reviewPath),acceptanceSha256:await hash(acceptedPath),visualAccepted:true,allFramesIndividuallyViewed:false},
  mainIntegration,preservation:preserved,cloudCalls:0,newModelCalls:0,limitations:{physicalValidation:'unverified',subjectiveNarrationListening:'not-verified',youtubePosted:false,zennSubmitted:false},files};
 await save(join(out,'manifest.json'),manifest);
 assert.deepEqual(await inventory(out),PUBLIC_FILES);
 const finalFiles=await Promise.all(PUBLIC_FILES.map(fileRecord));await verifyPreservation(assets,preservationFile);
 await save(candidatePath,{format:'ugoku-goal016-submission-package-candidate-v1',createdAt:new Date().toISOString(),files:finalFiles,preservation:preserved,cloudCalls:0,newModelCalls:0,credentialValuesParsedOrPrinted:false});
 console.log(JSON.stringify({status:'staged-awaiting-root-secret-scan',candidateSha256:await hash(candidatePath),files:finalFiles.length}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main(argumentsFor(process.argv.slice(2),['assets-root','mode']));
