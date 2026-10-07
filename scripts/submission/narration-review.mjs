/** Offline narration QA; no app, engine or external service is opened.
 * node scripts/submission/narration-review.mjs --movie VOICED.mp4 --source ORIGINAL.mp4 --manifest narration.json --out NEW_DIRECTORY
 * Manifest: {sourceSha256,movieSha256,durationSeconds,segments:[{id,startSeconds,durationSeconds,endSeconds,text,spokenText}]}.
 * Objective PCM/browser measurements are not a listening, pronunciation or semantic review.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';

const DURATION=160.6,FRAMES=4015,RATE=48000,THRESHOLD=10**(-50/20),PAD=.2;
const hash=b=>createHash('sha256').update(b).digest('hex');
export function argumentsFor(args){
 const result={};assert.equal(args.length,8,'Four explicit path arguments required');
 for(let i=0;i<args.length;i+=2){const key=args[i];assert(['--movie','--source','--manifest','--out'].includes(key)&&!result[key.slice(2)],'Unknown/duplicate argument');assert(args[i+1]&&!args[i+1].startsWith('--'));result[key.slice(2)]=resolve(args[i+1]);}
 assert.equal(new Set(Object.values(result)).size,4,'Distinct inputs/output required');return result;
}
export function validateManifest(m){
 assert(/^[a-f0-9]{64}$/.test(m.sourceSha256)&&/^[a-f0-9]{64}$/.test(m.movieSha256));assert.equal(m.durationSeconds,DURATION);
 assert(Array.isArray(m.segments)&&m.segments.length>0&&m.segments.length<=100);let previous=0;const ids=new Set();
 for(const s of m.segments){assert(typeof s.id==='string'&&s.id.length>0&&!ids.has(s.id));ids.add(s.id);for(const key of ['startSeconds','durationSeconds','endSeconds'])assert(Number.isFinite(s[key]));assert(s.startSeconds>=previous-1e-6&&s.durationSeconds>0&&s.endSeconds<=DURATION+1e-6);assert(Math.abs(s.startSeconds+s.durationSeconds-s.endSeconds)<1e-5);assert(typeof s.text==='string'&&s.text.trim()&&typeof s.spokenText==='string'&&s.spokenText.trim());previous=s.endSeconds;}
 return m;
}
async function processBytes(command,args,maxBytes=8*1024**2){
 return new Promise((accept,reject)=>{
  const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});let length=0,error='',settled=false;const chunks=[];
  const fail=e=>{if(settled)return;settled=true;clearTimeout(timer);child.kill('SIGKILL');reject(e);};
  const timer=setTimeout(()=>fail(Error(`${command} timed out`)),120000);
  child.stdout.on('data',b=>{length+=b.length;if(length>maxBytes)fail(Error(`${command} output limit`));else chunks.push(b);});
  child.stderr.on('data',b=>{error+=b.toString();if(error.length>16000)fail(Error(`${command} error output limit`));});
  child.once('error',fail);child.once('close',code=>{if(settled)return;settled=true;clearTimeout(timer);if(code!==0||error.trim())reject(Error(`${command} exit ${code}: ${error.slice(0,3000)}`));else accept(Buffer.concat(chunks));});
 });
}
const probe=async(file,extra=[])=>JSON.parse((await processBytes('ffprobe',['-v','error',...extra,'-of','json',file],16*1024**2)).toString());
export function compareVideoPackets(source,movie){
 assert.equal(source.length,FRAMES);assert.equal(movie.length,source.length);
 for(let i=0;i<source.length;i++){
  const a=source[i],b=movie[i];assert.equal(b.data_hash,a.data_hash,`Changed encoded video packet ${i}`);assert.equal(b.size,a.size);assert.equal(b.flags,a.flags);
  for(const key of ['pts_time','dts_time','duration_time']){assert(Number.isFinite(Number(a[key]))&&Number.isFinite(Number(b[key])));assert(Math.abs(Number(a[key])-Number(b[key]))<1e-6,`Changed video timing ${i}:${key}`);}
 }
 return {count:source.length,encodedPayloadSizeFlagsAndTimestampsEqual:true,packetSequenceSha256:hash(JSON.stringify(source)),meaning:'The entire encoded video packet sequence and presentation timing are unchanged, including the burned-in subtitles. Audio/container bytes differ intentionally.'};
}
function rms(pcm,from,to){let sum=0;for(let i=from;i<to;i++)sum+=pcm[i]*pcm[i];return Math.sqrt(sum/Math.max(1,to-from));}
export function measurePcm(pcm,segments,rate=RATE){
 assert(pcm.length>0);let peak=0,overFullScale=0;
 for(const sample of pcm){assert(Number.isFinite(sample),'Nonfinite decoded PCM');peak=Math.max(peak,Math.abs(sample));if(Math.abs(sample)>=1)overFullScale++;}
 const block=Math.round(rate*.02),windows=[];
 for(let i=0;i<pcm.length;i+=block){const end=Math.min(i+block,pcm.length),amplitude=rms(pcm,i,end);if(amplitude>=THRESHOLD)windows.push({start:i/rate,end:end/rate,rms:amplitude});}
 const outside=windows.filter(w=>!segments.some(s=>w.end>=s.startSeconds-PAD&&w.start<=s.endSeconds+PAD));
 const measured=segments.map(s=>{
  const active=windows.filter(w=>w.end>s.startSeconds&&w.start<s.endSeconds),first=active[0],last=active.at(-1);
  const from=Math.max(0,Math.floor(s.startSeconds*rate)),to=Math.min(pcm.length,Math.ceil(s.endSeconds*rate));
  return {id:s.id,plannedStart:s.startSeconds,plannedEnd:s.endSeconds,segmentRms:rms(pcm,from,to),activeWindowCount:active.length,firstActiveSeconds:first?.start??null,lastActiveSeconds:last?.end??null,onsetAfterPlannedStartSeconds:first?first.start-s.startSeconds:null,tailBeforePlannedEndSeconds:last?s.endSeconds-last.end:null};
 });
 return {sampleRate:rate,channels:1,samples:pcm.length,durationSeconds:pcm.length/rate,overallRms:rms(pcm,0,pcm.length),samplePeak:peak,samplesAtOrAboveFullScale:overFullScale,activityThresholdDbfs:-50,windowSeconds:.02,timingToleranceSeconds:PAD,segments:measured,activeOutsideScheduledWindowsSeconds:outside.reduce((n,w)=>n+w.end-w.start,0),outsideWindows:outside,limitation:'Decoded mono PCM activity measures signal timing, not words, pronunciation, intelligibility, perceptual loudness or speaker audibility. Float sample peak is not a true-peak measurement.'};
}
export function summarizeBrowserAudio(samples,segments){
 assert(samples.length>0,'No browser audio observations');
 assert(samples.every(s=>s.muted===false&&s.volume===1&&s.rate===1&&s.contextState==='running'),'Audio was muted, paused by AudioContext, attenuated or rate changed');
 const active=samples.filter(s=>s.rms>=THRESHOLD);
 const perSegment=segments.map(s=>({id:s.id,observations:samples.filter(x=>x.mediaTime>=s.startSeconds&&x.mediaTime<=s.endSeconds).length,activeObservations:active.filter(x=>x.mediaTime>=s.startSeconds-PAD&&x.mediaTime<=s.endSeconds+PAD).length}));
 assert(perSegment.every(s=>s.activeObservations>0),'At least one planned narration interval had no browser-decoded signal');
 return {observationCount:samples.length,activeObservationCount:active.length,activityThresholdDbfs:-50,perSegment,unmutedVolumeOneAndContextRunningThroughout:true,limitation:'Signal observed in the media-element AudioContext graph connected to its destination. This does not prove sound reached a physical speaker or was heard by a person.'};
}
async function main(options){
 const [movie,source,manifestBytes]=await Promise.all([readFile(options.movie),readFile(options.source),readFile(options.manifest)]);
 assert(movie.length<200*1024**2&&source.length<200*1024**2);const manifest=validateManifest(JSON.parse(manifestBytes));
 assert.equal(hash(movie),manifest.movieSha256);assert.equal(hash(source),manifest.sourceSha256);
 // Refuse to overwrite any previous review. Never modify source/movie/manifest.
 await mkdir(options.out,{mode:0o700});
 const report={format:'ugoku-goal015-narration-objective-review-v1',startedAt:new Date().toISOString(),movie:{path:options.movie,sha256:hash(movie)},source:{path:options.source,sha256:hash(source)},manifest:{path:options.manifest,sha256:hash(manifestBytes)},result:'running',cloudCalls:0,newModelCalls:0,audioGenerationCalls:0,subjectiveListening:{performed:false,status:'not-verified',required:'A person must still listen for pronunciation, naturalness, intelligibility, distracting noise, perceived loudness and whether the narration describes the intended scene.'}};
 const save=()=>writeFile(resolve(options.out,'technical-review.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 let server,browser;await save();
 try{
  const [original,narrated]=await Promise.all([probe(options.source,['-show_streams','-show_format']),probe(options.movie,['-show_streams','-show_format'])]);
  assert.equal(original.streams.length,1,'Original must remain the previously reviewed silent movie');assert.equal(narrated.streams.length,2,'Exactly one video plus one narration track required');
  for(const p of [original,narrated]){const videos=p.streams.filter(s=>s.codec_type==='video');assert.equal(videos.length,1);const v=videos[0];assert.equal(v.codec_name,'h264');assert.equal(v.width,1920);assert.equal(v.height,1080);assert.equal(v.avg_frame_rate,'25/1');assert.equal(v.r_frame_rate,'25/1');assert.equal(Number(v.nb_frames),FRAMES);assert(Math.abs(Number(v.duration)-DURATION)<.001);assert(Math.abs(Number(p.format.duration)-DURATION)<.1);}
  const audio=narrated.streams.filter(s=>s.codec_type==='audio');assert.equal(audio.length,1);assert.equal(audio[0].codec_name,'aac');assert([1,2].includes(audio[0].channels));assert(Number(audio[0].sample_rate)>=22050);assert(Math.abs(Number(audio[0].start_time))<.1);assert(Math.abs(Number(audio[0].duration)-DURATION)<.1);
  report.probe={original,narrated};await save();
  const packetArgs=['-select_streams','v:0','-show_packets','-show_data_hash','sha256','-show_entries','packet=pts_time,dts_time,duration_time,size,flags,data_hash'];
  const [a,b]=await Promise.all([probe(options.source,packetArgs),probe(options.movie,packetArgs)]);report.videoPacketComparison=compareVideoPackets(a.packets,b.packets);
  await Promise.all([
   processBytes('ffmpeg',['-nostdin','-hide_banner','-v','error','-xerror','-i',options.source,'-map','0:v:0','-f','null','-']),
   processBytes('ffmpeg',['-nostdin','-hide_banner','-v','error','-xerror','-i',options.movie,'-map','0:v:0','-map','0:a:0','-f','null','-'])
  ]);report.fullDecode={original:'passed-all-video',narrated:'passed-all-video-and-audio'};
  const pcmBytes=await processBytes('ffmpeg',['-nostdin','-hide_banner','-v','error','-xerror','-i',options.movie,'-map','0:a:0','-ac','1','-ar',String(RATE),'-f','f32le','-'],40*1024**2);
  assert.equal(pcmBytes.length%4,0);const pcm=new Float32Array(pcmBytes.buffer.slice(pcmBytes.byteOffset,pcmBytes.byteOffset+pcmBytes.byteLength));
  report.pcm=measurePcm(pcm,manifest.segments);assert(Math.abs(report.pcm.durationSeconds-DURATION)<.1);assert.equal(report.pcm.samplesAtOrAboveFullScale,0,'Decoded audio clips at full scale');assert(report.pcm.segments.every(s=>s.activeWindowCount>=3),'Missing non-silent narration interval');assert(report.pcm.activeOutsideScheduledWindowsSeconds<=.2,'Audio activity falls outside the planned narration intervals');await save();
  console.log(JSON.stringify({stage:'media-checked',frames:FRAMES,videoStreamUnchanged:true,audioSegments:manifest.segments.length}));
  server=createServer((req,res)=>{
   if(req.method!=='GET'){res.writeHead(405);res.end();return;}
   if(req.url==='/movie.mp4'){
    let start=0,end=movie.length-1;const range=req.headers.range;
    if(range){const match=/^bytes=(\d+)-(\d*)$/.exec(range);if(!match){res.writeHead(416);res.end();return;}start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=movie.length){res.writeHead(416,{'Content-Range':`bytes */${movie.length}`});res.end();return;}}
    res.writeHead(range?206:200,{'Content-Type':'video/mp4','Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store',...(range?{'Content-Range':`bytes ${start}-${end}/${movie.length}`}:{})});res.end(movie.subarray(start,end+1));return;
   }
   if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}
   if(req.url!=='/'){res.writeHead(404);res.end();return;}
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end('<!doctype html><html lang="ja"><meta charset="utf-8"><title>Offline narration review</title><style>body{margin:0;background:#fafaf7}video{display:block;width:1920px;height:1080px}button{position:absolute;top:10px;left:10px;padding:16px}</style><video playsinline preload="auto" src="/movie.mp4"></video><button type="button">音声を有効にして再生</button></html>');
  });
  await new Promise((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,ignoreDefaultArgs:['--mute-audio']});
  report.browser={engine:'chromium',version:browser.version(),headless:true,removedDefaultArgument:'--mute-audio',autoplayPolicyOverride:false,start:'Playwright trusted button click; not muted autoplay',networkScope:'Only the immutable movie and HTML from one loopback origin'};
  const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});const pageErrors=[],consoleErrors=[],blocked=[];
  page.on('pageerror',e=>pageErrors.push(e.message));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());if(m.text().startsWith('NARRATION_PROGRESS '))console.log(m.text());});
  await page.route('**/*',r=>{if(new URL(r.request().url()).origin===origin)return r.continue();blocked.push(r.request().url());return r.abort();});
  await page.goto(origin,{waitUntil:'load'});
  await page.evaluate(({duration})=>{
   const video=document.querySelector('video'),button=document.querySelector('button');video.muted=false;video.defaultMuted=false;video.volume=1;video.playbackRate=1;
   window.__narrationReviewComplete=new Promise((accept,reject)=>{
    button.addEventListener('click',async()=>{
     button.hidden=true;const start=performance.now(),events=[],rates=[],samples=[],frames=[];let interval,timer,context,callbackFrames=0,nextProgress=15,lastFrameSample=-10;
     try{
      context=new AudioContext();const source=context.createMediaElementSource(video),analyser=context.createAnalyser();analyser.fftSize=2048;source.connect(analyser);analyser.connect(context.destination);const pcm=new Float32Array(analyser.fftSize);
      video.addEventListener('ratechange',()=>rates.push({time:video.currentTime,rate:video.playbackRate}));
      for(const type of ['seeking','seeked','stalled','waiting','pause','error','volumechange'])video.addEventListener(type,()=>events.push({type,time:video.currentTime,errorCode:video.error?.code??null,muted:video.muted,volume:video.volume}));
      interval=setInterval(()=>{analyser.getFloatTimeDomainData(pcm);let sum=0,peak=0;for(const value of pcm){sum+=value*value;peak=Math.max(peak,Math.abs(value));}samples.push({mediaTime:video.currentTime,wallMs:performance.now()-start,audioContextTime:context.currentTime,rms:Math.sqrt(sum/pcm.length),peak,muted:video.muted,volume:video.volume,rate:video.playbackRate,contextState:context.state});},50);
      video.requestVideoFrameCallback(function frame(_now,meta){callbackFrames++;if(meta.mediaTime>=lastFrameSample+10){frames.push({mediaTime:meta.mediaTime,wallMs:performance.now()-start,presentedFrames:meta.presentedFrames});lastFrameSample=meta.mediaTime;}if(meta.mediaTime>=nextProgress){console.log('NARRATION_PROGRESS '+JSON.stringify({mediaTime:meta.mediaTime,rate:video.playbackRate,muted:video.muted,contextState:context.state}));nextProgress+=15;}if(!video.ended)video.requestVideoFrameCallback(frame);});
      const complete=new Promise((ok,fail)=>{video.addEventListener('ended',ok,{once:true});video.addEventListener('error',()=>fail(Error('Media playback error')),{once:true});timer=setTimeout(()=>fail(Error('Local playback timeout')),duration*1000+60000);});
      await Promise.all([context.resume(),video.play()]);await complete;clearInterval(interval);clearTimeout(timer);
      const q=video.getVideoPlaybackQuality();accept({ended:video.ended,duration:video.duration,currentTime:video.currentTime,wallMs:performance.now()-start,playbackRate:video.playbackRate,muted:video.muted,volume:video.volume,callbackFrames,quality:{totalVideoFrames:q.totalVideoFrames,droppedVideoFrames:q.droppedVideoFrames,corruptedVideoFrames:q.corruptedVideoFrames},context:{state:context.state,sampleRate:context.sampleRate,baseLatency:context.baseLatency,outputLatency:context.outputLatency??null},samples,frames,rates,events});
     }catch(e){reject(e);}finally{clearInterval(interval);clearTimeout(timer);await context?.close();}
    },{once:true});
   });
   // Attach a rejection handler immediately; the outer Playwright call awaits the same promise.
   window.__narrationReviewComplete.catch(()=>{});
  },{duration:DURATION});
  await page.getByRole('button',{name:'音声を有効にして再生'}).click();
  const playback=await page.evaluate(()=>window.__narrationReviewComplete);report.playback=playback;report.browserErrors={pageErrors,consoleErrors,blockedExternalRequests:blocked};
  await page.screenshot({path:resolve(options.out,'playback-ended.png')});
  assert(playback.ended&&playback.muted===false&&playback.volume===1&&playback.context.state==='running');assert.equal(playback.playbackRate,1);assert(Math.abs(playback.currentTime-DURATION)<.1);assert(playback.wallMs>=DURATION*1000-1000&&playback.wallMs<DURATION*1000+60000);assert.equal(playback.quality.corruptedVideoFrames,0);assert(playback.rates.every(x=>x.rate===1));assert(!playback.events.some(x=>['seeking','seeked','error'].includes(x.type)||(x.type==='pause'&&x.time<DURATION-.1)));assert.equal(pageErrors.length+consoleErrors.length+blocked.length,0);
  report.browserAudio=summarizeBrowserAudio(playback.samples,manifest.segments);report.playbackDropReviewRequired=playback.quality.droppedVideoFrames>0;
  report.result='objective-pass-listening-not-verified';report.completedAt=new Date().toISOString();await save();
  console.log(JSON.stringify({result:report.result,durationSeconds:DURATION,videoPacketsIdentical:true,quality:playback.quality,browserAudioSegments:report.browserAudio.perSegment.length,subjectiveListening:'not-verified',output:options.out}));
 }catch(error){report.result='failed';report.error=String(error.message).slice(0,4000);report.failedAt=new Date().toISOString();await save();throw error;}
 finally{await browser?.close();if(server)await new Promise(accept=>server.close(accept));}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main(argumentsFor(process.argv.slice(2)));
