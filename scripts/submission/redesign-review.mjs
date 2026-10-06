/** Local review of the completed submission movie; never opens the app or Cloud.
 * Wait for the renderer's completion before running.
 * node scripts/submission/redesign-review.mjs --assets-root /absolute/artifacts/submission
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {execFileSync,spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {chromium} from '@playwright/test';
assert.equal(process.argv[2],'--assets-root');assert.equal(process.argv.length,4);
const assets=resolve(process.argv[3]);
const movie=join(assets,'public/goal011/review-v2/demo.mp4');
const work=join(assets,'private/material-redesign-20261006/video');
const output=join(work,'review');await mkdir(output,{recursive:true,mode:0o700});
const sha=b=>createHash('sha256').update(b).digest('hex');
const save=async(name,value)=>writeFile(join(output,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const bytes=await readFile(movie),edlBytes=await readFile(join(work,'edit-decisions.json'));
const edl=JSON.parse(edlBytes);assert.equal(sha(bytes),edl.sha256,'Movie must match completed EDL');
assert.equal(edl.scenes.length,20);assert(Math.abs(edl.durationSeconds-177.12)<1e-6);
assert.equal(edl.newCloudCalls,0);assert.equal(edl.newModelCalls,0);
const fps=25,totalFrames=4428,midpoints=[],boundaries=[];
let previous=0;
for(const [i,s]of edl.scenes.entries()){
 assert(Math.abs(s.outputStart-previous)<1e-6,'Noncontiguous EDL');assert(s.outputEnd>s.outputStart);
 assert(Math.abs((s.outputEnd-s.outputStart)-s.duration)<1e-6);
 assert(Math.abs(s.outputStart*fps-Math.round(s.outputStart*fps))<1e-6);
 assert(Math.abs(s.outputEnd*fps-Math.round(s.outputEnd*fps))<1e-6);
 if(s.kind==='video')assert.equal(s.playbackRate,1);
 const frame=Math.floor((s.outputStart+s.outputEnd)/2*fps);
 midpoints.push({kind:'midpoint',scene:s.id,frame,time:frame/fps,caption:s.caption});
 if(i>0){const cut=Math.round(s.outputStart*fps);boundaries.push({kind:'before-cut',scene:edl.scenes[i-1].id,next:s.id,frame:cut-1,time:(cut-1)/fps},{kind:'after-cut',scene:s.id,previous:edl.scenes[i-1].id,frame:cut,time:cut/fps});}
 previous=s.outputEnd;
}
assert(Math.abs(previous-177.12)<1e-6);assert.equal(boundaries.length,38);
const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',movie],{encoding:'utf8',maxBuffer:2_000_000}));
assert.equal(probe.streams.length,1,'No audio or extra streams');
const stream=probe.streams[0];assert.equal(stream.codec_type,'video');assert.equal(stream.codec_name,'h264');
assert.equal(stream.width,1920);assert.equal(stream.height,1080);assert.equal(stream.avg_frame_rate,'25/1');assert.equal(stream.r_frame_rate,'25/1');assert.equal(Number(stream.nb_frames),totalFrames);assert(Math.abs(Number(probe.format.duration)-177.12)<.001);
const report={format:'ugoku-review-v2-video-technical-v1',movie:relative(assets,movie),sha256:sha(bytes),edlSha256:sha(edlBytes),probe,startedAt:new Date().toISOString(),classification:'Edited actual recordings and explicitly labeled real stills. Offline review only, not a new product/Cloud test.',fullDecode:'pending',frameSampling:{midpoints:20,boundaryAdjacentFrames:38,method:'Actual decoded output frame indices; previous frame and first frame at each of19 scene cuts.',notClaimed:'Sampling is not manual inspection of all4428 full-resolution frames.'},visualReview:'pending-human-inspection',cloudCalls:0,newModelCalls:0};
await save('technical-review.json',report);
const ffmpeg=args=>new Promise((accept,reject)=>{const child=spawn('ffmpeg',['-nostdin','-hide_banner','-v','error',...args],{stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',b=>{error+=b.toString();});child.once('error',reject);child.once('close',code=>code===0&&!error.trim()?accept():reject(Error(`ffmpeg exit${code}: ${error.slice(0,4000)}`)));});
let server,browser;
try{
 await ffmpeg(['-xerror','-i',movie,'-map','0:v:0','-f','null','-']);report.fullDecode='passed-all4428-frames-no-errors';await save('technical-review.json',report);console.log(JSON.stringify({stage:'full-decode',result:'passed',frames:totalFrames}));
 const unique=[...new Set([...midpoints,...boundaries].map(x=>x.frame))].sort((a,b)=>a-b);
 const select=unique.map(n=>`eq(n\\,${n})`).join('+');
 await ffmpeg(['-y','-i',movie,'-vf',`select=${select}`,'-fps_mode','vfr','-start_number','0',join(output,'frame-%03d.png')]);
 for(const sample of [...midpoints,...boundaries])sample.file=`frame-${String(unique.indexOf(sample.frame)).padStart(3,'0')}.png`;
 const sampled=await Promise.all(unique.map(async(frame,i)=>{const file=`frame-${String(i).padStart(3,'0')}.png`,b=await readFile(join(output,file));return {file,frame,time:frame/fps,sha256:sha(b)};}));
 await save('frame-map.json',{movieSha256:sha(bytes),midpoints,boundaries,uniqueFrames:sampled});
 const contactPaths=[];
 browser=await chromium.launch({headless:true});
 const contact=await browser.newPage({viewport:{width:1920,height:1490},deviceScaleFactor:1});await contact.route('**/*',r=>r.abort());
 for(const [name,items]of [['contact-midpoints.png',midpoints],['contact-boundaries-01.png',boundaries.slice(0,20)],['contact-boundaries-02.png',boundaries.slice(20)]]){
  const cards=await Promise.all(items.map(async x=>`<figure><img src="data:image/png;base64,${(await readFile(join(output,x.file))).toString('base64')}"><figcaption>${x.scene} · ${x.kind} · ${x.time.toFixed(2)}s · frame${x.frame}</figcaption></figure>`));
  await contact.setContent(`<html><style>*{box-sizing:border-box}body{margin:0;display:grid;grid-template-columns:repeat(4,480px);align-content:start;background:#ebece7;font:16px sans-serif;color:#252923}figure{margin:0;width:480px;height:298px;border:1px solid #ccc}img{width:478px;height:269px;display:block}figcaption{height:27px;padding:4px 8px;white-space:nowrap;font-size:14px}</style><body>${cards.join('')}</body></html>`);
  await contact.evaluate(async()=>Promise.all([...document.images].map(i=>i.decode())));await contact.screenshot({path:join(output,name)});contactPaths.push(name);
 }
 await contact.close();report.frameSampling.extractedUniqueFrames=sampled.length;report.frameSampling.contacts=contactPaths;await save('technical-review.json',report);console.log(JSON.stringify({stage:'frame-extraction',midpoints:20,boundaryFrames:38,contacts:contactPaths}));
 // Serve only this immutable movie in memory. Valid byte ranges support Chromium.
 server=createServer((req,res)=>{
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  if(req.url==='/demo.mp4'){
   const range=req.headers.range;let start=0,end=bytes.length-1;
   if(range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);if(!m){res.writeHead(416);res.end();return;}start=Number(m[1]);if(m[2])end=Math.min(Number(m[2]),end);if(!Number.isSafeInteger(start)||start>end||start>=bytes.length){res.writeHead(416,{'Content-Range':`bytes */${bytes.length}`});res.end();return;}}
   res.writeHead(range?206:200,{'Content-Type':'video/mp4','Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store',...(range?{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}:{})});res.end(bytes.subarray(start,end+1));return;
  }
  if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}
  if(req.url!=='/'){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end('<!doctype html><html lang="ja"><meta charset="utf-8"><title>Local review-v2 playback</title><style>body{margin:0;background:#FAFAF7}video{display:block;width:1920px;height:1080px}</style><video muted playsinline preload="auto" src="/demo.mp4"></video></html>');
 });
 await new Promise((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});const pageErrors=[],consoleErrors=[],blocked=[];
 page.on('pageerror',e=>pageErrors.push(e.message));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());if(m.text().startsWith('PLAYBACK_PROGRESS '))console.log(m.text());});
 await page.route('**/*',r=>{if(new URL(r.request().url()).origin===origin)return r.continue();blocked.push(r.request().url());return r.abort();});
 await page.goto(origin,{waitUntil:'load'});
 const playback=await page.evaluate(async()=>{
  const video=document.querySelector('video');
  if(video.readyState<1)await new Promise((accept,reject)=>{video.addEventListener('loadedmetadata',accept,{once:true});video.addEventListener('error',()=>reject(Error('Metadata error')),{once:true});});
  const samples=[],rates=[],events=[],start=performance.now();let callbackFrames=0,lastSample=-10,nextProgress=15;
  video.playbackRate=1;
  video.addEventListener('ratechange',()=>rates.push({time:video.currentTime,rate:video.playbackRate}));
  for(const type of ['seeking','seeked','stalled','waiting','pause','error'])video.addEventListener(type,()=>events.push({type,time:video.currentTime,errorCode:video.error?.code??null}));
  video.requestVideoFrameCallback(function frame(_now,meta){callbackFrames++;if(meta.mediaTime>=lastSample+10){samples.push({mediaTime:meta.mediaTime,wallMs:performance.now()-start,presentedFrames:meta.presentedFrames});lastSample=meta.mediaTime;}if(meta.mediaTime>=nextProgress){console.log('PLAYBACK_PROGRESS '+JSON.stringify({mediaTime:meta.mediaTime,rate:video.playbackRate}));nextProgress+=15;}if(!video.ended)video.requestVideoFrameCallback(frame);});
  let timer;
  const complete=new Promise((accept,reject)=>{video.addEventListener('ended',accept,{once:true});video.addEventListener('error',()=>reject(Error(`Video error code${video.error?.code}`)),{once:true});timer=setTimeout(()=>reject(Error('Local playback timeout')),240_000);});
  try{await video.play();await complete;}finally{clearTimeout(timer);}
  const q=video.getVideoPlaybackQuality();return{ended:video.ended,duration:video.duration,currentTime:video.currentTime,wallMs:performance.now()-start,playbackRate:video.playbackRate,callbackFrames,quality:{totalVideoFrames:q.totalVideoFrames,droppedVideoFrames:q.droppedVideoFrames,corruptedVideoFrames:q.corruptedVideoFrames},samples,rates,events};
 });
 report.playback=playback;report.browserErrors={pageErrors,consoleErrors,blockedExternalRequests:blocked};
 await page.screenshot({path:join(output,'playback-ended.png')});
 assert(playback.ended);assert.equal(playback.playbackRate,1);assert(Math.abs(playback.currentTime-177.12)<.05);assert(playback.wallMs>=176_120&&playback.wallMs<240_000);
 assert.equal(playback.quality.corruptedVideoFrames,0);assert(playback.rates.every(x=>x.rate===1));assert(!playback.events.some(x=>['seeking','seeked','error'].includes(x.type)));assert.equal(pageErrors.length+consoleErrors.length+blocked.length,0);
 report.playbackDropReviewRequired=playback.quality.droppedVideoFrames>0;
 report.result='technical-pass-visual-review-pending';report.completedAt=new Date().toISOString();await save('technical-review.json',report);
 console.log(JSON.stringify({result:report.result,fullDecode:report.fullDecode,duration:playback.duration,wallMs:playback.wallMs,quality:playback.quality,output}));
}catch(error){report.result='failed';report.error=String(error.message).slice(0,4000);report.failedAt=new Date().toISOString();await save('technical-review.json',report);throw error;}
finally{await browser?.close();if(server)await new Promise(accept=>server.close(accept));}
