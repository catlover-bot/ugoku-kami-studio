/** Offline Goal014 review. Run only after the final renderer completes.
 * node scripts/submission/final-review.mjs --assets-root /absolute/artifacts/submission
 * Opens only a fresh loopback HTTP server containing the movie, never the app.
 * An existing review directory is preserved and causes a refusal.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {execFileSync,spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {chromium} from '@playwright/test';
assert.equal(process.argv[2],'--assets-root');assert.equal(process.argv.length,4);
const edition='goal014-final';
const assets=resolve(process.argv[3]);
const movie=join(assets,'public/goal014-final/demo.mp4');
const work=join(assets,'private/goal014-final/video');
const output=join(work,'review');
const sha=b=>createHash('sha256').update(b).digest('hex');
const save=async(name,value)=>writeFile(join(output,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const bytes=await readFile(movie),edlBytes=await readFile(join(work,'edit-decisions.json'));
const edl=JSON.parse(edlBytes);assert.equal(sha(bytes),edl.sha256,'Movie must match completed EDL');
assert(Array.isArray(edl.scenes)&&edl.scenes.length>=2);
const duration=edl.durationSeconds;assert(Number.isFinite(duration)&&duration>=150&&duration<=195,'Final movie must be 150–195 seconds');
assert.equal(edl.width,1920);assert.equal(edl.height,1080);assert.equal(edl.fps,25);
assert.equal(edl.newCloudCalls,0);assert.equal(edl.newModelCalls,0);
const fps=25,totalFrames=Math.round(duration*fps),midpoints=[],boundaries=[];
assert(Math.abs(duration*fps-totalFrames)<1e-6,'Duration must align to a whole output frame');
const ids=new Set();
let previous=0;
for(const [i,s]of edl.scenes.entries()){
 assert(typeof s.id==='string'&&/^[a-zA-Z0-9_-]+$/.test(s.id)&&!ids.has(s.id),'Unique safe scene ID required');ids.add(s.id);
 assert(['video','still'].includes(s.kind));
 assert.equal(sha(await readFile(s.input)),s.sourceSha256,'Scene input hash mismatch');
 if(s.kind==='video')assert(Number.isFinite(s.sourceStart)&&s.sourceStart>=0);
 // The reused raw recording also contains private settings. Only this previously
 // frame-verified recovery interval is permitted; do not extend a cut into settings.
 if(s.sourceSha256==='c791f1ed4338fe952fbcb564323cf862d252494faffe309f9f6a9eabe33a170a'){
  assert.equal(s.kind,'video');assert(s.sourceStart>=4.88&&s.sourceStart+s.duration<=15.000001,'Historical cut leaves the verified safe interval');
 }
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
assert(Math.abs(previous-duration)<1e-6);assert.equal(boundaries.length,2*(edl.scenes.length-1));
const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',movie],{encoding:'utf8',maxBuffer:2_000_000}));
assert.equal(probe.streams.length,1,'No audio or extra streams');
const stream=probe.streams[0];assert.equal(stream.codec_type,'video');assert.equal(stream.codec_name,'h264');
assert.equal(stream.width,1920);assert.equal(stream.height,1080);assert.equal(stream.avg_frame_rate,'25/1');assert.equal(stream.r_frame_rate,'25/1');assert.equal(Number(stream.nb_frames),totalFrames);assert(Math.abs(Number(probe.format.duration)-duration)<.001);
const report={format:'ugoku-goal014-video-technical-v1',edition,movie:relative(assets,movie),sha256:sha(bytes),edlSha256:sha(edlBytes),durationSeconds:duration,totalFrames,probe,startedAt:new Date().toISOString(),classification:'Edited actual recordings and explicitly labeled real stills. Offline review only, not a new product/Cloud test.',fullDecode:'pending',frameSampling:{midpoints:midpoints.length,boundaryAdjacentFrames:boundaries.length,method:`Actual decoded output frame indices; previous frame and first frame at each of ${edl.scenes.length-1} scene cuts.`,notClaimed:`Sampling is not manual inspection of all ${totalFrames} full-resolution frames.`},visualReview:'pending-human-inspection',cloudCalls:0,newModelCalls:0};
// Evidence is append-by-edition: never overwrite an existing review directory.
await mkdir(output,{mode:0o700});
await save('technical-review.json',report);
const ffmpeg=args=>new Promise((accept,reject)=>{const child=spawn('ffmpeg',['-nostdin','-hide_banner','-v','error',...args],{stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',b=>{error+=b.toString();});child.once('error',reject);child.once('close',code=>code===0&&!error.trim()?accept():reject(Error(`ffmpeg exit${code}: ${error.slice(0,4000)}`)));});
let server,browser;
try{
 await ffmpeg(['-xerror','-i',movie,'-map','0:v:0','-f','null','-']);report.fullDecode=`passed-all${totalFrames}-frames-no-errors`;await save('technical-review.json',report);console.log(JSON.stringify({stage:'full-decode',result:'passed',frames:totalFrames}));
 const unique=[...new Set([...midpoints,...boundaries].map(x=>x.frame))].sort((a,b)=>a-b);
 const select=unique.map(n=>`eq(n\\,${n})`).join('+');
 // Concatenated clips may change color metadata. Keep select's frame counter
 // continuous across those changes, and reject missing/extra extracted frames.
 await ffmpeg(['-y','-reinit_filter','0','-i',movie,'-vf',`select=${select}`,'-fps_mode','vfr','-start_number','0',join(output,'frame-%03d.png')]);
 assert.equal((await readdir(output)).filter(name=>/^frame-\d+\.png$/.test(name)).length,unique.length,'Extracted frame count must match the complete sample map');
 for(const sample of [...midpoints,...boundaries])sample.file=`frame-${String(unique.indexOf(sample.frame)).padStart(3,'0')}.png`;
 const sampled=await Promise.all(unique.map(async(frame,i)=>{const file=`frame-${String(i).padStart(3,'0')}.png`,b=await readFile(join(output,file));return {file,frame,time:frame/fps,sha256:sha(b)};}));
 await save('frame-map.json',{movieSha256:sha(bytes),midpoints,boundaries,uniqueFrames:sampled});
 const contactPaths=[];
 browser=await chromium.launch({headless:true});
 const contact=await browser.newPage({viewport:{width:1920,height:1490},deviceScaleFactor:1});await contact.route('**/*',r=>r.abort());
 const contactGroups=[];
 for(const [kind,items]of [['midpoints',midpoints],['boundaries',boundaries]])for(let offset=0;offset<items.length;offset+=20){
  const suffix=kind==='midpoints'&&items.length<=20?'':`-${String(offset/20+1).padStart(2,'0')}`;
  contactGroups.push([`contact-${kind}${suffix}.png`,items.slice(offset,offset+20)]);
 }
 for(const [name,items]of contactGroups){
  const cards=await Promise.all(items.map(async x=>`<figure><img src="data:image/png;base64,${(await readFile(join(output,x.file))).toString('base64')}"><figcaption>${x.scene} · ${x.kind} · ${x.time.toFixed(2)}s · frame${x.frame}</figcaption></figure>`));
  await contact.setContent(`<html><style>*{box-sizing:border-box}body{margin:0;display:grid;grid-template-columns:repeat(4,480px);align-content:start;background:#ebece7;font:16px sans-serif;color:#252923}figure{margin:0;width:480px;height:298px;border:1px solid #ccc}img{width:478px;height:269px;display:block}figcaption{height:27px;padding:4px 8px;white-space:nowrap;font-size:14px}</style><body>${cards.join('')}</body></html>`);
  await contact.evaluate(async()=>Promise.all([...document.images].map(i=>i.decode())));await contact.screenshot({path:join(output,name)});contactPaths.push(name);
 }
 await contact.close();report.frameSampling.extractedUniqueFrames=sampled.length;report.frameSampling.uniqueFrameHashes=sampled;report.frameSampling.contacts=contactPaths;await save('technical-review.json',report);console.log(JSON.stringify({stage:'frame-extraction',midpoints:midpoints.length,boundaryFrames:boundaries.length,contacts:contactPaths}));
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
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>Local ${edition} playback</title><style>body{margin:0;background:#FAFAF7}video{display:block;width:1920px;height:1080px}</style><video muted playsinline preload="auto" src="/demo.mp4"></video></html>`);
 });
 await new Promise((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});const pageErrors=[],consoleErrors=[],blocked=[];
 page.on('pageerror',e=>pageErrors.push(e.message));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());if(m.text().startsWith('PLAYBACK_PROGRESS '))console.log(m.text());});
 await page.route('**/*',r=>{if(new URL(r.request().url()).origin===origin)return r.continue();blocked.push(r.request().url());return r.abort();});
 await page.goto(origin,{waitUntil:'load'});
 const playbackTimeoutMs=Math.ceil(duration*1000)+60_000;
 const playback=await page.evaluate(async({playbackTimeoutMs})=>{
  const video=document.querySelector('video');
  if(video.readyState<1)await new Promise((accept,reject)=>{video.addEventListener('loadedmetadata',accept,{once:true});video.addEventListener('error',()=>reject(Error('Metadata error')),{once:true});});
  const samples=[],rates=[],events=[],start=performance.now();let callbackFrames=0,lastSample=-10,nextProgress=15;
  video.playbackRate=1;
  video.addEventListener('ratechange',()=>rates.push({time:video.currentTime,rate:video.playbackRate}));
  for(const type of ['seeking','seeked','stalled','waiting','pause','error'])video.addEventListener(type,()=>events.push({type,time:video.currentTime,errorCode:video.error?.code??null}));
  video.requestVideoFrameCallback(function frame(_now,meta){callbackFrames++;if(meta.mediaTime>=lastSample+10){samples.push({mediaTime:meta.mediaTime,wallMs:performance.now()-start,presentedFrames:meta.presentedFrames});lastSample=meta.mediaTime;}if(meta.mediaTime>=nextProgress){console.log('PLAYBACK_PROGRESS '+JSON.stringify({mediaTime:meta.mediaTime,rate:video.playbackRate}));nextProgress+=15;}if(!video.ended)video.requestVideoFrameCallback(frame);});
  let timer;
  const complete=new Promise((accept,reject)=>{video.addEventListener('ended',accept,{once:true});video.addEventListener('error',()=>reject(Error(`Video error code${video.error?.code}`)),{once:true});timer=setTimeout(()=>reject(Error('Local playback timeout')),playbackTimeoutMs);});
  try{await video.play();await complete;}finally{clearTimeout(timer);}
  const q=video.getVideoPlaybackQuality();return{ended:video.ended,duration:video.duration,currentTime:video.currentTime,wallMs:performance.now()-start,playbackRate:video.playbackRate,callbackFrames,quality:{totalVideoFrames:q.totalVideoFrames,droppedVideoFrames:q.droppedVideoFrames,corruptedVideoFrames:q.corruptedVideoFrames},samples,rates,events};
 },{playbackTimeoutMs});
 report.playback=playback;report.browserErrors={pageErrors,consoleErrors,blockedExternalRequests:blocked};
 await page.screenshot({path:join(output,'playback-ended.png')});
 assert(playback.ended);assert.equal(playback.playbackRate,1);assert(Math.abs(playback.currentTime-duration)<.05);assert(playback.wallMs>=duration*1000-1000&&playback.wallMs<playbackTimeoutMs);
 assert.equal(playback.quality.corruptedVideoFrames,0);assert(playback.rates.every(x=>x.rate===1));assert(!playback.events.some(x=>['seeking','seeked','error'].includes(x.type)));assert.equal(pageErrors.length+consoleErrors.length+blocked.length,0);
 report.playbackDropReviewRequired=playback.quality.droppedVideoFrames>0;
 report.result='technical-pass-visual-review-pending';report.completedAt=new Date().toISOString();await save('technical-review.json',report);
 console.log(JSON.stringify({result:report.result,fullDecode:report.fullDecode,duration:playback.duration,wallMs:playback.wallMs,quality:playback.quality,output}));
}catch(error){report.result='failed';report.error=String(error.message).slice(0,4000);report.failedAt=new Date().toISOString();await save('technical-review.json',report);throw error;}
finally{await browser?.close();if(server)await new Promise(accept=>server.close(accept));}
