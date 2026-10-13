/** Local two-stage package. Stage fixes bytes; seal requires a root-only secret-scan attestation. */
import assert from 'node:assert/strict';
import {writeFile,copyFile,constants,mkdtemp,lstat,access} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {EDITION,IMAGE_NAMES,argumentsFor,loadCapture,hash,read,save,inventory,verifyPreservation} from './goal016-media.mjs';
const args=argumentsFor(process.argv.slice(2),['assets-root','mode']);assert(['stage','seal'].includes(args.mode));
const assets=resolve(args['assets-root']),work=join(assets,'private',EDITION),out=join(assets,'public',EDITION);
const exists=p=>access(p).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
const preservationFile=resolve(assets,'../goal016/before/preservation.json');
const preserved=await verifyPreservation(assets,preservationFile);
const fileRecord=async file=>({file,bytes:(await lstat(join(out,file))).size,sha256:await hash(join(out,file))});
if(args.mode==='seal'){
 const candidatePath=join(work,'package-candidate.json'),candidate=await read(candidatePath),scan=await read(join(work,'secret-scan-attestation.json'));
 assert.equal(scan.format,'ugoku-goal016-secret-scan-v1');assert.equal(scan.result,'passed');assert.equal(scan.candidateSha256,await hash(candidatePath));
 assert.equal(scan.knownCredentialByteScan,true);assert.equal(scan.secretValuesPrinted,false);assert.equal(scan.visualNoCredential,true);
 assert.deepEqual(scan.files,candidate.files,'Scan must cover exact candidate file/hash/byte records in the same order');
 assert.deepEqual(await inventory(out),candidate.files.map(f=>f.file));
 for(const f of candidate.files)assert.deepEqual(await fileRecord(f.file),f,'Public candidate changed after the root scan');
 const stage=await mkdtemp(join(work,'zip-check-')),zip=join(assets,`ugoku-kami-${EDITION}.zip`),extracted=join(stage,'extracted');
 execFileSync('python3',['-c',`import pathlib,sys,zipfile
p=pathlib.Path(sys.argv[1]); zp=pathlib.Path(sys.argv[2]); extracted=pathlib.Path(sys.argv[3])
files=sorted(f for f in p.rglob('*') if f.is_file()); names=[p.name+'/'+f.relative_to(p).as_posix() for f in files]
with zipfile.ZipFile(zp,'x',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for f,name in zip(files,names): z.write(f,name)
with zipfile.ZipFile(zp) as z:
 assert z.namelist()==names and len(set(names))==len(names) and z.testzip() is None
 for info in z.infolist():
  assert not pathlib.PurePosixPath(info.filename).is_absolute() and '..' not in pathlib.PurePosixPath(info.filename).parts
 z.extractall(extracted)
for f,name in zip(files,names): assert f.read_bytes()==(extracted/name).read_bytes()
`,out,zip,extracted],{stdio:'pipe'});
 await verifyPreservation(assets,preservationFile);
 const result={format:'ugoku-goal016-package-result-v1',sealedAt:new Date().toISOString(),zip:relative(assets,zip),sha256:await hash(zip),bytes:(await lstat(zip)).size,files:candidate.files,candidateSha256:await hash(candidatePath),secretScanSha256:await hash(join(work,'secret-scan-attestation.json')),allZipFilesExtractedAndByteMatched:true,preservation:preserved,cloudCalls:0,newModelCalls:0,secretReadByPackager:false};
 await save(join(work,'package-result.json'),result);console.log(JSON.stringify({status:'sealed',zip:result.zip,sha256:result.sha256,files:result.files.length}));
}else{
 assert(!await exists(join(work,'package-candidate.json')),'An existing staged edition must be preserved; no implicit replacement');
 const intake=await read(join(work,'capture-intake.json'));const evidence=await loadCapture(assets,join(assets,intake.capture)),capture=evidence.capture;
 assert.equal(intake.captureSha256,evidence.sha256);
 const edlPath=join(work,'video/edit-decisions.json'),edl=await read(edlPath),reviewPath=join(work,'video/review/technical-review.json'),review=await read(reviewPath),accepted=await read(join(work,'acceptance.json'));
 const movieSha=await hash(join(out,'demo.mp4'));assert.equal(edl.sha256,movieSha);assert.equal(edl.captureSha256,evidence.sha256);assert.equal(review.sha256,movieSha);assert.equal(review.edlSha256,await hash(edlPath));
 assert.equal(review.result,'technical-pass-visual-review-pending');assert.equal(review.totalFrames,edl.frames);assert.equal(review.fullDecode,`passed-all${edl.frames}-frames-no-errors`);
 assert.equal(review.playback.ended,true);assert.equal(review.playback.playbackRate,1);assert.equal(review.playback.quality.corruptedVideoFrames,0);assert.equal(review.browserErrors.pageErrors.length+review.browserErrors.consoleErrors.length+review.browserErrors.blockedExternalRequests.length,0);
 assert.equal(accepted.accepted,true);assert.equal(accepted.videoSha256,movieSha);assert(accepted.visual&&typeof accepted.visual==='object');
 if(review.playback.quality.droppedVideoFrames>0)assert.equal(accepted.visual.droppedFramesReviewed,true);
 const copyPath=fileURLToPath(new URL('./goal016-copy.json',import.meta.url)),copy=await read(copyPath);assert.equal(copy.edition,EDITION);assert.equal(copy.publicAppUrl,capture.publicOrigin);
 assert.equal(accepted.images?.length,4);const images=[];
 for(const image of intake.images){assert.equal(image.file,`images/${IMAGE_NAMES[image.role]}`);assert.equal(await hash(join(out,image.file)),image.sha256);assert(accepted.images.some(i=>i.file===image.file&&i.sha256===image.sha256));images.push({...image,...copy.images.find(i=>i.role===image.role),processing:'none; exact bytes from this new public workflow'});}
 assert.equal(await hash(join(out,'adopted-same-version.pdf')),capture.pdf.sha256);
 const architecture=await read(join(work,'architecture/provenance.json'));assert.equal(await hash(join(out,'architecture.png')),architecture.sha256);assert.equal(accepted.architectureSha256,architecture.sha256);
 let narration=null;
 const narrationManifest=join(work,'narration/output/manifest.json');
 if(await exists(narrationManifest)){
  const n=await read(narrationManifest),nrPath=join(work,'narration/review/technical-review.json'),nr=await read(nrPath);
  assert.equal(n.sourceSha256,movieSha);assert.equal(n.durationSeconds,edl.durationSeconds);assert.equal(nr.result,'objective-pass-listening-not-verified');assert.equal(nr.source.sha256,movieSha);assert.equal(nr.movie.sha256,n.movieSha256);assert.equal(nr.videoPacketComparison.count,edl.frames);assert.equal(nr.playback.ended,true);assert.equal(nr.playback.muted,false);assert.equal(nr.playback.volume,1);assert.equal(nr.playback.playbackRate,1);
  if(nr.playback.quality.droppedVideoFrames>0)assert.equal(accepted.visual.narrationDroppedFramesReviewed,true);
  for(const file of ['demo-narrated.mp4','narration-timed.txt','youtube-audio-credit.txt'])await copyFile(join(work,'narration/output',file),join(out,file),constants.COPYFILE_EXCL);
  assert.equal(await hash(join(out,'demo-narrated.mp4')),n.movieSha256);
  narration={file:'demo-narrated.mp4',sha256:n.movieSha256,credit:n.credit,engineVersion:n.engineVersion,voice:n.voice,sourceVideoSha256:movieSha,videoPacketsUnchanged:true,objectiveReviewSha256:await hash(nrPath),subjectiveListening:'not-verified',conditionsUrl:'https://voicevox.hiroshiba.jp/nemo/term/'};
 }
 const textCounts={};
 for(const [key,file] of [['problemSolution','problem-solution.txt'],['architecture','architecture-description.txt']]){const text=copy.submissionTextDrafts[key];assert(typeof text==='string'&&text.trim());textCounts[key]={codePoints:[...text].length,utf16:text.length};assert(textCounts[key].codePoints<=800&&textCounts[key].utf16<=800);await writeFile(join(out,file),text+'\n',{flag:'wx'});}
 await writeFile(join(out,'review-instructions-public-note.txt'),['うごく紙工房 — 公開用の操作案内','',capture.publicOrigin,'',...copy.publicReviewNote.map((line,i)=>`${i+1}. ${line}`),''].join('\n'),{flag:'wx'});
 const integrationPath=join(work,'integration-status.json');let mainIntegration=null;
 if(await exists(integrationPath)){mainIntegration=await read(integrationPath);assert(/^[a-f0-9]{40}$/.test(mainIntegration.mainSha));assert.equal(mainIntegration.pushed,true);assert.deepEqual(mainIntegration.ci.map(x=>x.name).sort(),['Check','WebKit representative workflow']);assert(mainIntegration.ci.every(x=>x.headSha===mainIntegration.mainSha&&x.status==='completed'&&x.conclusion==='success'));}
 const ai=capture.liveAi;const stampText=s=>`${s.designId} / 第${s.revision}版 / ${s.designHash}`;
 const readme=[
  'うごく紙工房 — Goal016 現行UI・実AIの提出候補','',
  '保存先：artifacts/submission/public/goal016-final/',
  'ZIP：artifacts/submission/ugoku-kami-goal016-final.zip',
  `公開アプリ：${capture.publicOrigin}`,
  `今回の収録：${capture.capturedAt} / 公開source ${capture.sourceSha} / revision ${capture.revision}`,'',
  '画像4枚（新しい一連の実操作から、画像加工なし）',...images.map((i,n)=>`${n+1}. ${i.file} — ${i.title}。${i.description}\n   ${stampText(i.stamp)}`),copy.imageSequenceNote,'',
  `動画：${narration?'demo-narrated.mp4（音声付き）／demo.mp4（無音原本）':'demo.mp4（無音）'}。${edl.durationSeconds.toFixed(2)}秒 / 1920×1080 / 25fps。`,
  `編集：${edl.editingNote}`,
  `実AI：今回の公開UIから1依頼、モデル送信${ai.modelCalls}回。希望${ai.requestedMm}mm、採用${ai.adoptedMm}mm。${ai.proposalKind==='alternative'?'希望とは異なる代案を比較して採用。':'希望の距離に一致する案を比較して採用。'}`,
  '現在・希望・候補の違いを確認し、本人の採用操作から同版PDF・ガイド・保存再開へ進みました。',
  `PDF：adopted-same-version.pdf / A4 ${capture.pdf.pages}ページ / ${stampText(ai.adopted)}`,
  '同じ版の確認と、実物の印刷・組立・動作の成功は別です。実物は未確認です。','',
  '構成図：architecture.png（今回のシステム説明図。アプリの実画面ではありません）。',
  '紹介文：problem-solution.txt／architecture-description.txt。公開手順：review-instructions-public-note.txt。',
  '審査用コードはこの一式に含みません。設定画面は公開する動画区間と画像から除いています。',
  ...(narration?[narration.credit,'音声はローカルVOICEVOX Nemoで生成。外部音声API・本人の声の複製は不使用。','YouTube説明欄にも同じ音声クレジットを記載してください。利用規約：https://voicevox.hiroshiba.jp/nemo/term/','助手による耳での聴感確認は未実施。客観的な音声信号・同期・全編再生の確認と区別しています。']:[]),
  ...copy.readmeNotes,
  mainIntegration?`制作コードmain：${mainIntegration.mainSha}（同SHA CI成功）。収録公開SHAとは別に記録。`:'最終main統合・CIの情報は別の引継ぎ記録を参照してください。収録SHAへ付け替えません。',''
 ];
 await writeFile(join(out,'README.txt'),readme.join('\n'),{flag:'wx'});
 const allowed=['README.txt','adopted-same-version.pdf','architecture-description.txt','architecture.png','captions.srt','demo.mp4',...Object.values(IMAGE_NAMES).map(n=>'images/'+n),'problem-solution.txt','review-instructions-public-note.txt',...(narration?['demo-narrated.mp4','narration-timed.txt','youtube-audio-credit.txt']:[])].sort();
 assert.deepEqual(await inventory(out),allowed,'Unexpected public file or missing required asset');
 const files=await Promise.all(allowed.map(fileRecord));
 const manifest={format:'ugoku-goal016-public-materials-v1',edition:EDITION,createdAt:new Date().toISOString(),status:'LOCAL_DRAFT_REVIEWED',packageVerificationRecord:'private/goal016-final/package-result.json',publicAppUrl:capture.publicOrigin,capture:{file:relative(assets,evidence.path),sha256:evidence.sha256,capturedAt:capture.capturedAt,sourceSha:capture.sourceSha,revision:capture.revision,imageDigest:capture.imageDigest},liveAi:{...ai,newRequests:capture.newModelRequests,source:'actual current public Vertex workflow'},images,pdf:{file:'adopted-same-version.pdf',sha256:capture.pdf.sha256,...capture.pdf.stamp,pages:capture.pdf.pages,A4:true},video:{file:'demo.mp4',sha256:movieSha,durationSeconds:edl.durationSeconds,width:1920,height:1080,fps:25,frames:edl.frames,edlSha256:await hash(edlPath),editingNote:edl.editingNote,oldUiFootage:0},narration,architecture:{file:'architecture.png',sha256:architecture.sha256,kind:architecture.kind},mainIntegration,textCounts,copySha256:await hash(copyPath),review:{technicalSha256:await hash(reviewPath),visual:accepted.visual,acceptanceSha256:await hash(join(work,'acceptance.json'))},preservation:preserved,limitations:{physicalValidation:'unverified',subjectiveNarrationListening:narration?'not-verified':'not-applicable',youtubePosted:false,zennSubmitted:false},files};
 await save(join(out,'manifest.json'),manifest);
 const finalFiles=await Promise.all((await inventory(out)).map(fileRecord));
 await verifyPreservation(assets,preservationFile);
 const candidate={format:'ugoku-goal016-package-candidate-v1',createdAt:new Date().toISOString(),files:finalFiles,preservation:preserved,secretReadByPackager:false,cloudCalls:0,newModelCalls:0};
 await save(join(work,'package-candidate.json'),candidate);console.log(JSON.stringify({status:'staged-awaiting-root-secret-scan',candidate:join(work,'package-candidate.json'),candidateSha256:await hash(join(work,'package-candidate.json')),files:finalFiles.length}));
}
